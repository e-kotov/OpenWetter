//! ICON-D2 map layers, chart series and run history.
//!
//! For the newest complete DWD ICON-D2 run: download every field needed for 13 layers (one
//! DWD file per field in memory at a time), sample the native triangular mesh onto a regular
//! ~2 km lat/lon grid, quantise to 8 bits and write lossless WebP map tiles (128 x 128 cells x
//! 24 frames). The same values are also packed per 32 x 32-cell block into one gzip file with
//! every layer and frame, so a chart for a tapped place needs a single download. Runs are kept
//! for `--keep-runs` (default 40 = 5 days) and listed newest-first in `latest.json`.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::FileExt,
    path::PathBuf,
    time::{Duration, Instant},
};

use serde_json::{Map, Value, json};

use crate::common::*;

const ROOT: &str = "https://opendata.dwd.de/weather/nwp/v1/m/icon-d2/p/";
const LAT_STEP: f64 = 0.02; // ~2.2 km, close to the native ~2.1 km mesh spacing
const LON_STEP: f64 = 0.03; // ~2.1 km at 51.5 N
const CUTOFF_DEG: f64 = 0.04; // nearest native cell further away -> no data
const TILE: usize = 128;
const SERIES: usize = 32; // chart block size in cells
const HISTORY_TILE: usize = 256;
const HISTORY_MINUTES: usize = 180; // DWD runs every 3 h, so each run supplies 3 h of history
const FRAMES: usize = 24; // frames per tile image
const LAST_STEP: usize = 192; // +48 h in 15-minute steps

/// How a layer's physical value is derived from its DWD fields and stored in 8 bits.
#[derive(Clone, Copy, PartialEq)]
enum Code {
    /// Sum of 15-minute differences of accumulated fields, as mm/h, log scale.
    LogRate,
    /// Percent 0..100, 1 % steps.
    Percent,
    /// Kelvin field shown in degrees Celsius, 0.5 °C steps from -60 °C.
    TempC,
    /// Pa field shown in hPa, 1 hPa steps from 900 hPa.
    Pressure,
    /// m/s, 0.25 m/s steps; with two fields the speed of the (u, v) vector.
    Speed,
    /// Meteorological direction the wind blows from, 1.5° steps, from (u, v).
    Direction,
}

impl Code {
    fn quantise(self, v: f32) -> u8 {
        if !v.is_finite() {
            return NODATA;
        }
        let q = |x: f32, max: f32| x.round().clamp(0.0, max) as u8;
        match self {
            Code::LogRate => log_rate_code(v),
            Code::Percent => q(v, 100.0),
            Code::TempC => q((v + 60.0) * 2.0, 254.0),
            Code::Pressure => q(v - 900.0, 254.0),
            Code::Speed => q(v * 4.0, 254.0),
            Code::Direction => ((v / 1.5).round() as u32 % 240) as u8,
        }
    }

    /// Physical value from the per-field values of one cell (differences for accumulated fields).
    fn value(self, f: &[f32]) -> f32 {
        match self {
            // f32::max(NaN, 0) is 0, so missing values must be caught first.
            Code::LogRate if f.iter().any(|x| x.is_nan()) => f32::NAN,
            Code::LogRate => f.iter().map(|x| x.max(0.0)).sum::<f32>() * 4.0, // mm per 15 min -> mm/h
            Code::Percent => f[0],
            Code::TempC => f[0] - 273.15,
            Code::Pressure => f[0] / 100.0,
            Code::Speed if f.len() == 2 => libm::hypotf(f[0], f[1]),
            Code::Speed => f[0],
            Code::Direction => {
                let d = libm::atan2f(-f[0], -f[1]).to_degrees();
                if d < 0.0 { d + 360.0 } else { d }
            }
        }
    }

    fn describe(self) -> Value {
        match self {
            Code::LogRate => log_rate_describe(),
            Code::Percent => json!({"unit": "%", "decode": "value = code"}),
            Code::TempC => json!({"unit": "°C", "decode": "value = code / 2 - 60"}),
            Code::Pressure => json!({"unit": "hPa", "decode": "value = code + 900"}),
            Code::Speed => json!({"unit": "m/s", "decode": "value = code / 4"}),
            Code::Direction => json!({"unit": "degrees, direction the wind blows from (0 = north)", "decode": "value = code * 1.5"}),
        }
    }
}

struct Layer {
    name: &'static str,
    code: Code,
}

/// A group of layers computed from the same DWD fields.
struct Job {
    fields: &'static [&'static str],
    hourly: bool,
    accumulated: bool,
    layers: &'static [Layer],
}

impl Job {
    fn steps(&self) -> Vec<usize> {
        let stride = if self.hourly { 4 } else { 1 };
        (1..=LAST_STEP / stride).map(|i| i * stride).collect()
    }
}

const JOBS: &[Job] = &[
    Job { fields: &["TOT_PREC"], hourly: false, accumulated: true, layers: &[Layer { name: "precip", code: Code::LogRate }] },
    Job { fields: &["SNOW_GSP", "SNOW_CON"], hourly: false, accumulated: true, layers: &[Layer { name: "snow", code: Code::LogRate }] },
    Job { fields: &["CLCT"], hourly: true, accumulated: false, layers: &[Layer { name: "cloud_total", code: Code::Percent }] },
    Job { fields: &["CLCL"], hourly: true, accumulated: false, layers: &[Layer { name: "cloud_low", code: Code::Percent }] },
    Job { fields: &["CLCM"], hourly: true, accumulated: false, layers: &[Layer { name: "cloud_mid", code: Code::Percent }] },
    Job { fields: &["CLCH"], hourly: true, accumulated: false, layers: &[Layer { name: "cloud_high", code: Code::Percent }] },
    Job { fields: &["T_2M"], hourly: true, accumulated: false, layers: &[Layer { name: "temperature", code: Code::TempC }] },
    Job { fields: &["TD_2M"], hourly: true, accumulated: false, layers: &[Layer { name: "dew_point", code: Code::TempC }] },
    Job { fields: &["RELHUM_2M"], hourly: true, accumulated: false, layers: &[Layer { name: "humidity", code: Code::Percent }] },
    Job { fields: &["PMSL"], hourly: true, accumulated: false, layers: &[Layer { name: "pressure", code: Code::Pressure }] },
    Job {
        fields: &["U_10M", "V_10M"],
        hourly: true,
        accumulated: false,
        layers: &[Layer { name: "wind_speed", code: Code::Speed }, Layer { name: "wind_direction", code: Code::Direction }],
    },
    Job { fields: &["VMAX_10M"], hourly: true, accumulated: false, layers: &[Layer { name: "wind_gust", code: Code::Speed }] },
];

#[derive(Default)]
struct Timer {
    download: Duration,
    decode: Duration,
    regrid: Duration,
    encode: Duration,
    upload: Duration,
}

/// Chart series scratch file: per 32x32 block, every layer's frames back to back.
struct SeriesFile {
    file: fs::File,
    bx: usize,
    by: usize,
    total_frames: usize,
}

impl SeriesFile {
    const BLOCK: usize = SERIES * SERIES;

    fn create(path: PathBuf, width: usize, height: usize, total_frames: usize) -> Res<SeriesFile> {
        let _ = fs::remove_file(&path); // leftover from a crash before the unlink below
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&path)?;
        // Unlink at once: the space is freed when the file is closed, even if the process is killed.
        fs::remove_file(&path)?;
        Ok(SeriesFile { file, bx: width.div_ceil(SERIES), by: height.div_ceil(SERIES), total_frames })
    }

    /// Store one whole-grid frame at global frame index `g`.
    fn write_frame(&self, frame: &[u8], width: usize, height: usize, g: usize) -> Res<()> {
        let mut buf = vec![NODATA; Self::BLOCK];
        for sy in 0..self.by {
            for sx in 0..self.bx {
                buf.fill(NODATA);
                let (w, h) = (SERIES.min(width - sx * SERIES), SERIES.min(height - sy * SERIES));
                for r in 0..h {
                    let src = (sy * SERIES + r) * width + sx * SERIES;
                    buf[r * w..r * w + w].copy_from_slice(&frame[src..src + w]);
                }
                let b = sy * self.bx + sx;
                self.file.write_all_at(&buf, ((b * self.total_frames + g) * Self::BLOCK) as u64)?;
            }
        }
        Ok(())
    }
}

pub fn run(args: &[String]) -> Res<()> {
    let history_days: i64 = arg(args, "--history-days").map(|v| v.parse()).transpose()?.unwrap_or(5);
    let grace_minutes: i64 = arg(args, "--grace-minutes").map(|v| v.parse()).transpose()?.unwrap_or(30);
    let max_uploads: u64 = arg(args, "--max-uploads-month").map(|v| v.parse()).transpose()?.unwrap_or(500_000);
    let state_path = PathBuf::from(arg(args, "--state").unwrap_or_else(|| "openwetter-icon-state.json".into()));
    let sink = Sink::from_args(flag(args, "--publish"), arg(args, "--out"))?;
    let agent = agent();

    let mut state = State::load(&state_path, json!({"runs": [], "history": [], "month": "", "uploads": 0}))?;
    // Every invocation (every 15 min): remove superseded runs after the grace period, expire history.
    let removed = housekeeping(&sink, &mut state, grace_minutes, history_days)?;
    if removed > 0 {
        println!("housekeeping: {removed} superseded or expired objects deleted");
    }
    let run = match arg(args, "--run") {
        Some(r) => r,
        None => latest_complete_run(&agent)?,
    };
    let runs = state.v["runs"].as_array().cloned().unwrap_or_default();
    if !flag(args, "--force") && runs.iter().any(|r| r["run"] == run.as_str()) {
        println!("ICON-D2 run {run} already published; nothing to do");
        return Ok(());
    }
    let run_key = run.replace(':', "");
    let run_enc = run.replace(':', "%3A");
    let run_start = parse_iso(&format!("{run}:00")).ok_or("bad run time")?;
    println!("ICON-D2 run {run}: publishing {} layer groups, chart series and history slice", JOBS.len());
    let started = Instant::now();
    let mut t = Timer::default();

    let lat = decode(&fetch(&agent, &field_url(&run_enc, "CLAT", 0), &mut t)?, &mut t)?;
    let lon = decode(&fetch(&agent, &field_url(&run_enc, "CLON", 0), &mut t)?, &mut t)?;
    let grid = Grid::build(&lat, &lon);
    drop((lat, lon));
    let coverage = grid.index.iter().filter(|&&i| i != u32::MAX).count() as f64 / grid.index.len() as f64;
    if coverage < 0.7 {
        return Err(format!("native mesh covers only {:.0}% of the grid", coverage * 100.0).into());
    }
    let grid_json = json!({"west": grid.west, "north": grid.north, "lon_step": LON_STEP, "lat_step": LAT_STEP,
                           "width": grid.width, "height": grid.height, "row0": "north"});

    // Global frame offsets of each layer inside a chart series block.
    let mut series_layers = Vec::new();
    let mut total_frames = 0;
    for job in JOBS {
        for layer in job.layers {
            let n = job.steps().len();
            series_layers.push(json!({"name": layer.name, "frames": n, "step_minutes": if job.hourly {60} else {15},
                                      "first_step_minutes": job.steps()[0] * 15}));
            total_frames += n;
        }
    }
    let series = SeriesFile::create(state_path.with_extension("series.work"), grid.width, grid.height, total_frames)?;

    let mut keys = Vec::new();
    let mut slice = Slice::default();
    let mut layers_manifest = Map::new();
    let mut bytes_total = 0usize;
    let mut layer_offset = 0;
    for job in JOBS {
        let (b, entries) = publish_job(job, &agent, &sink, &grid, &run_enc, &run_key, &mut state, max_uploads, &mut keys, &series, layer_offset, &mut slice, &mut t)?;
        layer_offset += job.layers.len() * job.steps().len();
        bytes_total += b;
        for (name, entry) in entries {
            layers_manifest.insert(name, entry);
        }
        println!("{}: done, {:.0} s so far", job.layers.iter().map(|l| l.name).collect::<Vec<_>>().join("+"), started.elapsed().as_secs_f64());
    }

    // Chart series: one gzip per 32x32 block with every layer and frame.
    let s = Instant::now();
    let mut series_tiles = Vec::new();
    let mut series_bytes = 0;
    let mut series_keys: Vec<String> = Vec::new();
    let mut batch = Vec::new();
    let mut block = vec![0u8; total_frames * SeriesFile::BLOCK];
    for sy in 0..series.by {
        for sx in 0..series.bx {
            let (w, h) = (SERIES.min(grid.width - sx * SERIES), SERIES.min(grid.height - sy * SERIES));
            let b = sy * series.bx + sx;
            series.file.read_exact_at(&mut block, (b * total_frames * SeriesFile::BLOCK) as u64)?;
            if block.iter().all(|&v| v == NODATA) {
                continue; // outside the model
            }
            let mut body = Vec::with_capacity(total_frames * w * h);
            for f in 0..total_frames {
                body.extend_from_slice(&block[f * SeriesFile::BLOCK..f * SeriesFile::BLOCK + w * h]);
            }
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
            gz.write_all(&body)?;
            let gz = gz.finish()?;
            series_bytes += gz.len();
            series_tiles.push(json!([sx, sy]));
            batch.push((format!("icon_d2/{run_key}/series/{sx}_{sy}.bin.gz"), gz));
            if batch.len() >= 64 {
                state.count_uploads(batch.len() as u64, max_uploads)?;
                sink.put_many(&batch, "application/octet-stream", IMMUTABLE)?;
                series_keys.extend(batch.drain(..).map(|(k, _)| k));
            }
        }
    }
    state.count_uploads(batch.len() as u64, max_uploads)?;
    sink.put_many(&batch, "application/octet-stream", IMMUTABLE)?;
    series_keys.extend(batch.drain(..).map(|(k, _)| k));
    drop(series); // closing the unlinked scratch file frees its disk space
    t.upload += s.elapsed();
    println!("chart series: {} blocks, {:.1} MB, {:.0} s so far", series_tiles.len(), series_bytes as f64 / 1e6, started.elapsed().as_secs_f64());

    let manifest = json!({
        "schema": "openwetter-tiles-2",
        "source": "DWD ICON-D2 open data, CC BY 4.0 (https://opendata.dwd.de)",
        "model": "icon_d2", "run": run, "generated_at": unix_now(), "grid": grid_json,
        "tile": TILE, "frames_per_chunk": FRAMES,
        "encoding": {"format": "lossless WebP, grey (R=G=B), frames stacked top to bottom", "nodata": NODATA,
                     "tiles": "[x, y, bytes]; tile path = layer/cNN/{x}_{y}.webp"},
        "layers": layers_manifest,
        "series": {"tile": SERIES, "path": "series/{x}_{y}.bin.gz", "tiles": series_tiles, "layers": series_layers,
                   "encoding": "gzip; for each layer in order: frames x h x w uint8 codes (same codes as the map), rows north to south; w, h smaller at the east/south edge"},
    });
    let manifest_key = format!("icon_d2/{run_key}/manifest.json");
    state.count_uploads(1, max_uploads)?;
    sink.put(&manifest_key, &serde_json::to_vec(&manifest)?, "application/json", IMMUTABLE)?;
    keys.push(manifest_key);

    // Record the run and its history slice, then switch readers over.
    let mut runs: Vec<Value> = runs.into_iter().filter(|r| r["run"] != run.as_str()).collect();
    runs.push(json!({"run": run, "keys": keys, "series_keys": series_keys, "published_at": unix_now()}));
    runs.sort_by(|a, b| a["run"].as_str().cmp(&b["run"].as_str()));
    let mut history: Vec<Value> = state.v["history"].as_array().cloned().unwrap_or_default();
    history.retain(|h| h["run"] != run.as_str());
    history.push(json!({"run": run, "run_key": run_key, "start": run_start, "keys": slice.keys, "layers": slice.layers}));
    history.sort_by_key(|h| h["start"].as_i64());
    state.v["runs"] = json!(runs);
    state.v["history"] = json!(history);
    state.v["grid"] = grid_json;
    write_history_index(&sink, &mut state, max_uploads)?;
    let newest = runs.last().and_then(|r| r["run"].as_str()).unwrap_or(&run).to_owned();
    let latest = json!({"schema": "openwetter-tiles-2", "generated_at": unix_now(),
                         "icon_d2": {"run": newest, "manifest": format!("icon_d2/{}/manifest.json", newest.replace(':', "")),
                                     "history": "icon_d2/history/index.json"},
                         "radar": "radar/index.json", "nowcast": "nowcast/index.json", "warnings": "warnings/index.json"});
    state.count_uploads(1, max_uploads)?;
    sink.put("latest.json", &serde_json::to_vec(&latest)?, "application/json", SHORT)?;
    state.save()?;

    // Remove anything under icon_d2/ that the state does not reference (e.g. left by a crashed run).
    let swept = sweep(&sink, "icon_d2/", &referenced_keys(&state))?;

    let s = |d: Duration| d.as_secs_f64();
    println!(
        "done in {:.0} s: {:.1} MB map tiles + {:.1} MB chart series + {:.1} MB history slice; download {:.0} s, decode {:.1} s, regrid {:.1} s, encode {:.1} s, upload {:.0} s; \
         {swept} orphaned objects swept; uploads this month {}",
        started.elapsed().as_secs_f64(), bytes_total as f64 / 1e6, series_bytes as f64 / 1e6, slice.bytes as f64 / 1e6,
        s(t.download), s(t.decode), s(t.regrid), s(t.encode), s(t.upload), state.uploads()
    );
    Ok(())
}

/// First three hours of every layer of one run, kept for the history (newer runs cover later hours).
#[derive(Default)]
struct Slice {
    keys: Vec<String>,
    layers: Map<String, Value>,
    bytes: usize,
}

/// Every object key the state references under icon_d2/.
fn referenced_keys(state: &State) -> std::collections::HashSet<String> {
    let mut keep = std::collections::HashSet::from(["icon_d2/history/index.json".to_owned()]);
    let lists = state.v["runs"].as_array().into_iter().flatten().flat_map(|r| [&r["keys"], &r["series_keys"]])
        .chain(state.v["history"].as_array().into_iter().flatten().map(|h| &h["keys"]));
    for list in lists {
        keep.extend(list.as_array().into_iter().flatten().filter_map(|k| k.as_str().map(str::to_owned)));
    }
    keep
}

/// Delete superseded runs once their successor has been live for the grace period, and history
/// slices older than `history_days`. Returns the number of deleted objects.
fn housekeeping(sink: &Sink, state: &mut State, grace_minutes: i64, history_days: i64) -> Res<usize> {
    let now = unix_now();
    let mut runs: Vec<Value> = state.v["runs"].as_array().cloned().unwrap_or_default();
    runs.sort_by(|a, b| a["run"].as_str().cmp(&b["run"].as_str()));
    let mut doomed: Vec<String> = Vec::new();
    let successors: Vec<i64> = runs.iter().skip(1).map(|r| r["published_at"].as_i64().unwrap_or(0)).collect();
    let mut kept = Vec::new();
    for (i, r) in runs.into_iter().enumerate() {
        let superseded = successors.get(i).is_some_and(|&p| now - p >= grace_minutes * 60);
        if superseded {
            for list in [&r["keys"], &r["series_keys"]] {
                doomed.extend(list.as_array().into_iter().flatten().filter_map(|k| k.as_str().map(str::to_owned)));
            }
        } else {
            kept.push(r);
        }
    }
    let mut history: Vec<Value> = state.v["history"].as_array().cloned().unwrap_or_default();
    let before = history.len();
    let (old, keep): (Vec<Value>, Vec<Value>) = history.drain(..).partition(|h| h["start"].as_i64().is_some_and(|s| s < now - history_days * 86_400));
    for h in &old {
        doomed.extend(h["keys"].as_array().into_iter().flatten().filter_map(|k| k.as_str().map(str::to_owned)));
    }
    if doomed.is_empty() && keep.len() == before {
        return Ok(0);
    }
    // Save the shrunken state first: a crash after this point leaves only orphans, which the sweep removes.
    state.v["runs"] = json!(kept);
    state.v["history"] = json!(keep);
    if keep.len() != before {
        write_history_index(sink, state, u64::MAX)?;
    }
    state.save()?;
    for key in &doomed {
        sink.delete(key)?;
    }
    Ok(doomed.len())
}

fn write_history_index(sink: &Sink, state: &mut State, max_uploads: u64) -> Res<()> {
    let codes: Map<String, Value> = JOBS.iter().flat_map(|j| j.layers.iter()).map(|l| (l.name.to_owned(), l.code.describe())).collect();
    let slices: Vec<Value> = state.v["history"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .map(|h| json!({"run": h["run"], "run_key": h["run_key"], "start": h["start"], "layers": h["layers"]}))
        .collect();
    let index = json!({
        "schema": "openwetter-history-1",
        "source": "DWD ICON-D2 open data, CC BY 4.0 (https://opendata.dwd.de)",
        "generated_at": unix_now(), "grid": state.v["grid"], "tile": HISTORY_TILE,
        "path": "icon_d2/history/{run_key}/{layer}/{x}_{y}.webp",
        "encoding": "lossless WebP, grey (R=G=B), frames stacked top to bottom; per layer: frames from first_step_minutes after the run, every step_minutes; codes as in the run manifest",
        "codes": codes, "slices": slices,
    });
    if max_uploads != u64::MAX {
        state.count_uploads(1, max_uploads)?;
    }
    sink.put("icon_d2/history/index.json", &serde_json::to_vec(&index)?, "application/json", SHORT)
}


/// Download, regrid, quantise, encode and upload every chunk of one job's layers.
#[allow(clippy::too_many_arguments)]
fn publish_job(
    job: &Job,
    agent: &ureq::Agent,
    sink: &Sink,
    grid: &Grid,
    run_enc: &str,
    run_key: &str,
    state: &mut State,
    max_uploads: u64,
    keys: &mut Vec<String>,
    series: &SeriesFile,
    layer_offset: usize,
    slice: &mut Slice,
    t: &mut Timer,
) -> Res<(usize, Vec<(String, Value)>)> {
    let step_minutes = if job.hourly { 60 } else { 15 };
    let steps = job.steps();
    let plane = grid.width * grid.height;
    let nl = job.layers.len();
    let nf = job.fields.len();
    let mut frames = vec![NODATA; plane * FRAMES * nl];
    // Previous accumulated values per field (accumulation is zero at the run start).
    let mut previous: Vec<Option<Vec<f32>>> = vec![None; nf];
    let mut rgb = Vec::new();
    let mut chunks: Vec<Vec<Value>> = vec![Vec::new(); nl];
    let mut bytes_total = 0;
    let mut cell = vec![0f32; nf];

    for (chunk, chunk_steps) in steps.chunks(FRAMES).enumerate() {
        frames.fill(NODATA);
        for (k, &step) in chunk_steps.iter().enumerate() {
            let mut current = Vec::with_capacity(nf);
            for field in job.fields {
                current.push(decode(&fetch(agent, &field_url(run_enc, field, step), t)?, t)?);
            }
            let s = Instant::now();
            for (px, &c) in grid.index.iter().enumerate() {
                if c == u32::MAX {
                    continue;
                }
                let c = c as usize;
                for f in 0..nf {
                    let now = current[f][c];
                    cell[f] = if job.accumulated { now - previous[f].as_ref().map_or(0.0, |p| p[c]) } else { now };
                }
                for (l, layer) in job.layers.iter().enumerate() {
                    frames[(l * FRAMES + k) * plane + px] = layer.code.quantise(layer.code.value(&cell));
                }
            }
            for l in 0..nl {
                let g = layer_offset + l * steps.len() + chunk * FRAMES + k;
                series.write_frame(&frames[(l * FRAMES + k) * plane..(l * FRAMES + k + 1) * plane], grid.width, grid.height, g)?;
            }
            t.regrid += s.elapsed();
            if job.accumulated {
                previous = current.into_iter().map(Some).collect();
            }
        }

        if chunk == 0 {
            // History slice: the first 3 hours of each layer, in larger tiles (few objects per run).
            let n = HISTORY_MINUTES / step_minutes;
            for (l, layer) in job.layers.iter().enumerate() {
                let layer_frames = &frames[l * FRAMES * plane..(l * FRAMES + n) * plane];
                let (mut batch, mut tiles) = (Vec::new(), Vec::new());
                for ty in 0..grid.height.div_ceil(HISTORY_TILE) {
                    for tx in 0..grid.width.div_ceil(HISTORY_TILE) {
                        let (w, h, data, nonzero) = tile_rgb(layer_frames, n, grid.width, grid.height, HISTORY_TILE, tx, ty, &mut rgb);
                        if !data || (layer.code == Code::LogRate && !nonzero) {
                            continue;
                        }
                        let s = Instant::now();
                        let webp = encode_lossless(&rgb, w as u32, (h * n) as u32)?;
                        t.encode += s.elapsed();
                        tiles.push(json!([tx, ty, webp.len()]));
                        slice.bytes += webp.len();
                        batch.push((format!("icon_d2/history/{run_key}/{}/{tx}_{ty}.webp", layer.name), webp));
                    }
                }
                state.count_uploads(batch.len() as u64, max_uploads)?;
                sink.put_many(&batch, "image/webp", IMMUTABLE)?;
                slice.keys.extend(batch.into_iter().map(|(k, _)| k));
                slice.layers.insert(layer.name.to_owned(), json!({"step_minutes": step_minutes, "first_step_minutes": chunk_steps[0] * 15,
                                                                  "frames": n, "tiles": tiles}));
            }
        }
        for (l, layer) in job.layers.iter().enumerate() {
            let layer_frames = &frames[l * FRAMES * plane..(l + 1) * FRAMES * plane];
            let mut batch = Vec::new();
            let mut tiles = Vec::new();
            for ty in 0..grid.height.div_ceil(TILE) {
                for tx in 0..grid.width.div_ceil(TILE) {
                    let (w, h, data, nonzero) = tile_rgb(layer_frames, chunk_steps.len(), grid.width, grid.height, TILE, tx, ty, &mut rgb);
                    if !data || (layer.code == Code::LogRate && !nonzero) {
                        continue; // outside the model, or dry rain/snow for the whole chunk
                    }
                    let s = Instant::now();
                    let webp = encode_lossless(&rgb, w as u32, (h * chunk_steps.len()) as u32)?;
                    t.encode += s.elapsed();
                    let key = format!("icon_d2/{run_key}/{}/c{chunk:02}/{tx}_{ty}.webp", layer.name);
                    tiles.push(json!([tx, ty, webp.len()]));
                    bytes_total += webp.len();
                    batch.push((key, webp));
                }
            }
            chunks[l].push(json!({"chunk": chunk, "first_step_minutes": chunk_steps[0] * 15,
                                  "frames": chunk_steps.len(), "tiles": tiles}));
            state.count_uploads(batch.len() as u64, max_uploads)?;
            let s = Instant::now();
            sink.put_many(&batch, "image/webp", IMMUTABLE)?;
            t.upload += s.elapsed();
            keys.extend(batch.into_iter().map(|(k, _)| k));
        }
    }

    let entries = job
        .layers
        .iter()
        .zip(chunks)
        .map(|(layer, chunk_list)| {
            (layer.name.to_owned(), json!({
                "step_minutes": step_minutes,
                "fields": job.fields,
                "missing_tile": if layer.code == Code::LogRate { "dry for the whole chunk, or outside the model" } else { "outside the model" },
                "code": layer.code.describe(),
                "chunks": chunk_list,
            }))
        })
        .collect();
    Ok((bytes_total, entries))
}

/// DWD file for a field at a lead time given in 15-minute steps.
fn field_url(run_enc: &str, field: &str, step: usize) -> String {
    format!("{ROOT}{field}/r/{run_enc}/s/PT{:03}H{:02}M.grib2", step / 4, (step % 4) * 15)
}

fn fetch(agent: &ureq::Agent, url: &str, t: &mut Timer) -> Res<Vec<u8>> {
    let s = Instant::now();
    let bytes = get(agent, url)?;
    t.download += s.elapsed();
    if !bytes.starts_with(b"GRIB") {
        return Err(format!("not a GRIB2 file: {url}").into());
    }
    Ok(bytes)
}

fn decode(bytes: &[u8], t: &mut Timer) -> Res<Vec<f32>> {
    let s = Instant::now();
    let grib2 = grib::from_bytes(bytes)?;
    let (_, sub) = grib2.iter().next().ok_or("empty GRIB2 message")?;
    let values: Vec<f32> = grib::Grib2SubmessageDecoder::from(sub)?.dispatch()?.collect();
    t.decode += s.elapsed();
    Ok(values)
}

/// Newest run whose +48 h file is published for every field.
fn latest_complete_run(agent: &ureq::Agent) -> Res<String> {
    let mut runs: Vec<String> = listing(agent, &format!("{ROOT}TOT_PREC/r/"))?
        .into_iter()
        .map(|h| h.trim_end_matches('/').to_owned())
        .filter(|h| h.len() == 16 && h.as_bytes()[10] == b'T')
        .collect();
    runs.sort();
    'runs: for run in runs.iter().rev() {
        let enc = run.replace(':', "%3A");
        for field in JOBS.iter().flat_map(|j| j.fields.iter()).chain(["CLAT", "CLON"].iter()) {
            let step = if *field == "CLAT" || *field == "CLON" { 0 } else { LAST_STEP };
            if agent.head(&field_url(&enc, field, step)).call()?.status() != 200 {
                continue 'runs;
            }
        }
        return Ok(run.clone());
    }
    Err("no complete ICON-D2 run yet".into())
}

/// Regular lat/lon output grid with a nearest-native-cell index per pixel.
struct Grid {
    west: f64,
    north: f64,
    width: usize,
    height: usize,
    /// Native cell for each output pixel (row 0 = north); u32::MAX = outside the model.
    index: Vec<u32>,
}

impl Grid {
    fn build(lat: &[f32], lon: &[f32]) -> Grid {
        let fold = |f: fn(f32, f32) -> f32, v: &[f32], init: f32| v.iter().copied().filter(|x| x.is_finite()).fold(init, f);
        let (south, north) = (fold(f32::min, lat, f32::MAX) as f64, fold(f32::max, lat, f32::MIN) as f64);
        let (west, east) = (fold(f32::min, lon, f32::MAX) as f64, fold(f32::max, lon, f32::MIN) as f64);
        let width = ((east - west) / LON_STEP).floor() as usize + 1;
        let height = ((north - south) / LAT_STEP).floor() as usize + 1;
        let scale = libm::cos(51.5f64.to_radians());

        // Bucket the native cells on a coarse grid so each pixel searches only 3x3 buckets.
        let b = CUTOFF_DEG;
        let bw = ((east - west) * scale / b).ceil() as usize + 1;
        let bh = ((north - south) / b).ceil() as usize + 1;
        let bucket_of = |la: f64, lo: f64| {
            let bx = (((lo - west) * scale) / b) as usize;
            let by = ((la - south) / b) as usize;
            by.min(bh - 1) * bw + bx.min(bw - 1)
        };
        let mut counts = vec![0u32; bw * bh + 1];
        for (&la, &lo) in lat.iter().zip(lon) {
            counts[bucket_of(la as f64, lo as f64) + 1] += 1;
        }
        for i in 1..counts.len() {
            counts[i] += counts[i - 1];
        }
        let mut fill = counts.clone();
        let mut members = vec![0u32; lat.len()];
        for (i, (&la, &lo)) in lat.iter().zip(lon).enumerate() {
            let k = bucket_of(la as f64, lo as f64);
            members[fill[k] as usize] = i as u32;
            fill[k] += 1;
        }
        drop(fill);

        let mut index = vec![u32::MAX; width * height];
        for row in 0..height {
            let la = north - row as f64 * LAT_STEP;
            for col in 0..width {
                let lo = west + col as f64 * LON_STEP;
                let bx = (((lo - west) * scale) / b) as isize;
                let by = ((la - south) / b) as isize;
                let mut best = (CUTOFF_DEG * CUTOFF_DEG, u32::MAX);
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let (x, y) = (bx + dx, by + dy);
                        if x < 0 || y < 0 || x >= bw as isize || y >= bh as isize {
                            continue;
                        }
                        let k = y as usize * bw + x as usize;
                        for &m in &members[counts[k] as usize..counts[k + 1] as usize] {
                            let ddx = (lon[m as usize] as f64 - lo) * scale;
                            let ddy = lat[m as usize] as f64 - la;
                            let d = ddx * ddx + ddy * ddy;
                            if d <= best.0 {
                                best = (d, m);
                            }
                        }
                    }
                }
                index[row * width + col] = best.1;
            }
        }
        Grid { west, north, width, height, index }
    }
}
