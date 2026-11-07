//! ICON map layers, chart series and run history for ICON-D2, ICON-EU and ICON Global.
//!
//! For the newest complete DWD run of the chosen `--model`: download every field needed for 13
//! layers (one DWD file per field in memory at a time), sample the native triangular mesh onto a
//! regular lat/lon grid (ICON-D2 ~2 km over its whole domain; ICON-EU ~6.5 km and ICON Global
//! ~13 km cropped to the same Germany-and-neighbours box), quantise to 8 bits and write lossless
//! WebP map tiles (128 x 128 cells x up to 24 frames). The same values are also packed per
//! 32 x 32-cell block into one gzip with every layer and frame, so a chart for a tapped
//! place needs a single download. ICON-D2 also keeps a 5-day history of 3-hour slices.
//!
//! Uploads are packed: a layer's tiles go back to back into one object per run, the series
//! blocks into parts of at most 16 MB, a history slice into one object. The manifest lists
//! every tile's size in pack order, so readers find a tile's byte range by adding up the sizes
//! before it. A run takes a few dozen uploads instead of thousands (R2's free tier counts
//! uploads); readers download the same bytes as with one file per tile.
//!
//! Lead times: ICON-D2 every 15 minutes (rain, snow) or hour to +48 h, every run (3-hourly).
//! ICON-EU hourly to +78 h, then 3-hourly to +120 h, from the 00/06/12/18 UTC runs (the others
//! stop earlier). ICON Global only adds the days after ICON-EU: 3-hourly +111 h to +180 h, from
//! the 00/12 UTC runs (its files cover the whole planet, so the rest is not downloaded).

use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::FileExt,
    path::PathBuf,
    time::{Duration, Instant},
};

use serde_json::{Map, Value, json};

use crate::common::*;

/// Lead times from `first` to `last` minutes, every `step` minutes.
#[derive(Clone, Copy)]
struct Seg {
    first: usize,
    last: usize,
    step: usize,
}

/// One DWD ICON model as published by OpenWetter.
struct Model {
    /// Object key prefix and manifest "model".
    id: &'static str,
    label: &'static str,
    root: &'static str,
    lat_step: f64,
    lon_step: f64,
    /// Nearest native cell further away than this (degrees) -> no data.
    cutoff: f64,
    /// [south, north, west, east]; None = the whole native mesh.
    bbox: Option<[f64; 4]>,
    /// UTC hours of the runs to publish.
    run_hours: &'static [u32],
    /// Lead times of hourly layers, and of 15-minute layers where the model has them.
    schedule: &'static [Seg],
    fast_schedule: Option<&'static [Seg]>,
    history: bool,
    min_coverage: f64,
}

/// Germany and its neighbours: the ICON-D2 domain, used for the coarser models too.
const REGION: [f64; 4] = [43.0, 58.2, -4.2, 20.5];

const MODELS: &[Model] = &[
    Model {
        id: "icon_d2", label: "ICON-D2", root: "https://opendata.dwd.de/weather/nwp/v1/m/icon-d2/p/",
        lat_step: 0.02, lon_step: 0.03, // ~2.2 km, close to the native ~2.1 km mesh spacing
        cutoff: 0.04, bbox: None,
        run_hours: &[0, 3, 6, 9, 12, 15, 18, 21],
        schedule: &[Seg { first: 60, last: 2880, step: 60 }],
        fast_schedule: Some(&[Seg { first: 15, last: 2880, step: 15 }]),
        history: true, min_coverage: 0.7,
    },
    Model {
        id: "icon_eu", label: "ICON-EU", root: "https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/",
        lat_step: 0.06, lon_step: 0.09, // ~6.5 km native mesh
        cutoff: 0.1, bbox: Some(REGION),
        run_hours: &[0, 6, 12, 18],
        schedule: &[Seg { first: 60, last: 78 * 60, step: 60 }, Seg { first: 81 * 60, last: 120 * 60, step: 180 }],
        fast_schedule: None,
        history: false, min_coverage: 0.95,
    },
    Model {
        id: "icon_global", label: "ICON", root: "https://opendata.dwd.de/weather/nwp/v1/m/icon/p/",
        lat_step: 0.12, lon_step: 0.18, // ~13 km native mesh
        cutoff: 0.2, bbox: Some(REGION),
        run_hours: &[0, 12],
        // Overlaps ICON-EU's last 9 hours so a newer Global run never leaves a gap.
        schedule: &[Seg { first: 111 * 60, last: 180 * 60, step: 180 }],
        fast_schedule: None,
        history: false, min_coverage: 0.95,
    },
];

impl Model {
    fn find(id: &str) -> Res<&'static Model> {
        MODELS.iter().find(|m| m.id == id).ok_or_else(|| format!("unknown model {id}; use icon_d2, icon_eu or icon_global").into())
    }

    /// Lead times (minutes) of a job's frames, and the minutes each frame covers since the
    /// previous lead time (the period of accumulated fields such as rain).
    fn frames(&self, job: &Job) -> (Vec<usize>, Vec<usize>) {
        let segs = if job.hourly { self.schedule } else { self.fast_schedule.unwrap_or(self.schedule) };
        let (mut leads, mut steps) = (Vec::new(), Vec::new());
        for s in segs {
            for l in (s.first..=s.last).step_by(s.step) {
                steps.push(leads.last().map_or(s.step.min(l), |&p| l - p));
                leads.push(l);
            }
        }
        (leads, steps)
    }

    fn last_lead(&self) -> usize {
        self.schedule.iter().map(|s| s.last).max().unwrap_or(0)
    }

    /// DWD file for a field at a lead time in minutes.
    fn field_url(&self, run_enc: &str, field: &str, minutes: usize) -> String {
        format!("{}{field}/r/{run_enc}/s/PT{:03}H{:02}M.grib2", self.root, minutes / 60, minutes % 60)
    }
}

/// Frames grouped into map chunks: at most FRAMES each, never mixing step lengths.
fn chunk_ranges(steps: &[usize]) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for i in 1..=steps.len() {
        if i == steps.len() || i - start == FRAMES || steps[i] != steps[start] {
            out.push(start..i);
            start = i;
        }
    }
    out
}

const TILE: usize = 128;
const SERIES: usize = 32; // chart block size in cells
const HISTORY_TILE: usize = 256;
const HISTORY_MINUTES: usize = 180; // DWD runs every 3 h, so each run supplies 3 h of history
const FRAMES: usize = 24; // frames per tile image
/// Chart series blocks are uploaded in parts of at most this size (the server's memory is small).
const SERIES_PART_BYTES: usize = 16 << 20;

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

    /// Physical value from the per-field values of one cell (differences for accumulated fields,
    /// over `hours`).
    fn value(self, f: &[f32], hours: f32) -> f32 {
        match self {
            // f32::max(NaN, 0) is 0, so missing values must be caught first.
            Code::LogRate if f.iter().any(|x| x.is_nan()) => f32::NAN,
            Code::LogRate => f.iter().map(|x| x.max(0.0)).sum::<f32>() / hours, // mm per period -> mm/h
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
    /// Only for this model (None = every model).
    only: Option<&'static str>,
    /// Chart series only, no map tiles (cloud cover on pressure levels).
    series_only: bool,
}

/// One ICON-EU pressure level of cloud cover, for the graphs' cloud layers.
macro_rules! cloud_level {
    ($pa:literal, $name:literal) => {
        Job {
            fields: &[concat!("CLC/lvt1/100/lv1/", $pa)],
            hourly: true,
            accumulated: false,
            layers: &[Layer { name: $name, code: Code::Percent }],
            only: Some("icon_eu"),
            series_only: true,
        }
    };
}

/// The jobs a model publishes.
fn jobs(model: &Model) -> impl Iterator<Item = &'static Job> + '_ {
    JOBS.iter().filter(move |j| j.only.is_none_or(|m| m == model.id))
}

const JOBS: &[Job] = &[
    Job { fields: &["TOT_PREC"], hourly: false, accumulated: true, layers: &[Layer { name: "precip", code: Code::LogRate }], only: None, series_only: false },
    Job { fields: &["SNOW_GSP", "SNOW_CON"], hourly: false, accumulated: true, layers: &[Layer { name: "snow", code: Code::LogRate }], only: None, series_only: false },
    Job { fields: &["CLCT"], hourly: true, accumulated: false, layers: &[Layer { name: "cloud_total", code: Code::Percent }], only: None, series_only: false },
    Job { fields: &["CLCL"], hourly: true, accumulated: false, layers: &[Layer { name: "cloud_low", code: Code::Percent }], only: None, series_only: false },
    Job { fields: &["CLCM"], hourly: true, accumulated: false, layers: &[Layer { name: "cloud_mid", code: Code::Percent }], only: None, series_only: false },
    Job { fields: &["CLCH"], hourly: true, accumulated: false, layers: &[Layer { name: "cloud_high", code: Code::Percent }], only: None, series_only: false },
    Job { fields: &["T_2M"], hourly: true, accumulated: false, layers: &[Layer { name: "temperature", code: Code::TempC }], only: None, series_only: false },
    Job { fields: &["TD_2M"], hourly: true, accumulated: false, layers: &[Layer { name: "dew_point", code: Code::TempC }], only: None, series_only: false },
    Job { fields: &["RELHUM_2M"], hourly: true, accumulated: false, layers: &[Layer { name: "humidity", code: Code::Percent }], only: None, series_only: false },
    Job { fields: &["PMSL"], hourly: true, accumulated: false, layers: &[Layer { name: "pressure", code: Code::Pressure }], only: None, series_only: false },
    Job {
        fields: &["U_10M", "V_10M"],
        hourly: true,
        accumulated: false,
        layers: &[Layer { name: "wind_speed", code: Code::Speed }, Layer { name: "wind_direction", code: Code::Direction }],
        only: None,
        series_only: false,
    },
    Job { fields: &["VMAX_10M"], hourly: true, accumulated: false, layers: &[Layer { name: "wind_gust", code: Code::Speed }], only: None, series_only: false },
    // ICON-EU cloud cover on pressure levels (the levels DWD publishes that the graphs draw).
    cloud_level!("100000", "cloud_1000hPa"),
    cloud_level!("95000", "cloud_950hPa"),
    cloud_level!("92500", "cloud_925hPa"),
    cloud_level!("90000", "cloud_900hPa"),
    cloud_level!("85000", "cloud_850hPa"),
    cloud_level!("80000", "cloud_800hPa"),
    cloud_level!("70000", "cloud_700hPa"),
    cloud_level!("60000", "cloud_600hPa"),
    cloud_level!("50000", "cloud_500hPa"),
    cloud_level!("40000", "cloud_400hPa"),
    cloud_level!("30000", "cloud_300hPa"),
    cloud_level!("25000", "cloud_250hPa"),
    cloud_level!("20000", "cloud_200hPa"),
];

/// Radar, nowcast and warnings updates run from inside a long publish. They share one lock
/// with it (the server has memory for one job at a time), so the separate 5-minute live job
/// would otherwise wait for the whole publish. Caps as in openwetter-live.service.
struct LiveTicks {
    dir: Option<PathBuf>,
    sink_args: Vec<String>,
    last: Instant,
    every: Duration,
}

impl LiveTicks {
    fn from_args(args: &[String]) -> LiveTicks {
        let sink_args = match arg(args, "--out") {
            Some(out) if !flag(args, "--publish") => vec!["--out".to_owned(), out],
            _ => vec!["--publish".to_owned()],
        };
        let every = arg(args, "--live-every").and_then(|v| v.parse().ok()).unwrap_or(300);
        LiveTicks { dir: arg(args, "--live-dir").map(PathBuf::from), sink_args, last: Instant::now(), every: Duration::from_secs(every) }
    }

    /// Run the live jobs if `--live-every` seconds (default 300) have passed since the publish
    /// started or they last ran.
    fn tick(&mut self) {
        let Some(dir) = &self.dir else { return };
        if self.last.elapsed() < self.every {
            return;
        }
        self.last = Instant::now();
        type Job = fn(&[String]) -> Res<()>;
        let live: [(&str, Job, &str); 3] = [
            ("radar", crate::radar::run_radar, "150000"),
            ("nowcast", crate::radar::run_nowcast, "100000"),
            ("warnings", crate::warnings::run, "30000"),
        ];
        for (name, job, cap) in live {
            let mut a = self.sink_args.clone();
            a.extend(["--state".to_owned(), dir.join(format!("{name}.json")).display().to_string(), "--max-uploads-month".to_owned(), cap.to_owned()]);
            if let Err(e) = job(&a) {
                eprintln!("live {name} during publish: {e}");
            }
        }
    }
}

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
    let model = Model::find(&arg(args, "--model").unwrap_or_else(|| "icon_d2".into()))?;
    let mut live = LiveTicks::from_args(args);
    let label = model.label;

    let mut state = State::load(&state_path, json!({"runs": [], "history": [], "month": "", "uploads": 0}))?;
    // Every invocation (every 15 min): remove superseded runs after the grace period, expire history.
    let removed = housekeeping(&sink, &mut state, grace_minutes, history_days)?;
    if removed > 0 {
        println!("housekeeping: {removed} superseded or expired objects deleted");
    }
    let run = match arg(args, "--run") {
        Some(r) => r,
        None => latest_complete_run(&agent, model)?,
    };
    let runs = state.v["runs"].as_array().cloned().unwrap_or_default();
    if !flag(args, "--force") && runs.iter().any(|r| r["run"] == run.as_str()) {
        println!("{label} run {run} already published; nothing to do");
        return Ok(());
    }
    let run_key = run.replace(':', "");
    let run_enc = run.replace(':', "%3A");
    let run_start = parse_iso(&format!("{run}:00")).ok_or("bad run time")?;
    println!("{label} run {run}: publishing {} layer groups and chart series{}", jobs(model).count(), if model.history { " and history slice" } else { "" });
    let started = Instant::now();
    let mut t = Timer::default();

    let lat = decode(&fetch(&agent, &model.field_url(&run_enc, "CLAT", 0), &mut t)?, &mut t)?;
    let lon = decode(&fetch(&agent, &model.field_url(&run_enc, "CLON", 0), &mut t)?, &mut t)?;
    let grid = Grid::build(&lat, lon, model);
    drop(lat);
    let coverage = grid.index.iter().filter(|&&i| i != u32::MAX).count() as f64 / grid.index.len() as f64;
    if coverage < model.min_coverage {
        return Err(format!("native mesh covers only {:.0}% of the grid", coverage * 100.0).into());
    }
    let grid_json = json!({"west": grid.west, "north": grid.north, "lon_step": model.lon_step, "lat_step": model.lat_step,
                           "width": grid.width, "height": grid.height, "row0": "north"});

    // Global frame offsets of each layer inside a chart series block.
    let mut series_layers = Vec::new();
    let mut total_frames = 0;
    for job in jobs(model) {
        for layer in job.layers {
            let (leads, steps) = model.frames(job);
            let n = leads.len();
            series_layers.push(json!({"name": layer.name, "frames": n, "step_minutes": steps[0],
                                      "first_step_minutes": leads[0], "lead_minutes": leads}));
            total_frames += n;
        }
    }
    let series = SeriesFile::create(state_path.with_extension("series.work"), grid.width, grid.height, total_frames)?;

    let mut keys = Vec::new();
    let mut slice = Slice::default();
    let mut layers_manifest = Map::new();
    let mut bytes_total = 0usize;
    let mut layer_offset = 0;
    for job in jobs(model) {
        let (b, entries) = publish_job(model, job, &agent, &sink, &grid, &run_enc, &run_key, &mut state, max_uploads, &mut keys, &series, layer_offset, &mut slice, &mut t)?;
        layer_offset += job.layers.len() * model.frames(job).0.len();
        live.tick();
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
    let (mut part, mut parts) = (Vec::new(), Vec::<usize>::new());
    let mut in_part = 0;
    let mut flush = |part: &mut Vec<u8>, state: &mut State| -> Res<()> {
        let key = format!("{}/{run_key}/series/{}.pack", model.id, series_keys.len());
        state.count_uploads(1, max_uploads)?;
        sink.put(&key, part, "application/octet-stream", IMMUTABLE)?;
        series_keys.push(key);
        part.clear();
        Ok(())
    };
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
            if !part.is_empty() && part.len() + gz.len() > SERIES_PART_BYTES {
                flush(&mut part, &mut state)?;
                parts.push(in_part);
                in_part = 0;
            }
            series_tiles.push(json!([sx, sy, gz.len()]));
            part.extend_from_slice(&gz);
            in_part += 1;
        }
    }
    if !part.is_empty() {
        flush(&mut part, &mut state)?;
        parts.push(in_part);
    }
    drop(part);
    if model.history {
        // History series: the first 3 hours of every layer, in 64 x 64-cell blocks (a quarter
        // of the objects), so the graphs can show the past day from the same model.
        let (n, bytes) = history_series(&grid, &series, &series_layers, &mut slice)?;
        println!("history series: {n} blocks, {:.1} MB", bytes as f64 / 1e6);
        let key = format!("{}/history/{run_key}/slice.pack", model.id);
        state.count_uploads(1, max_uploads)?;
        sink.put(&key, &slice.pack, "application/octet-stream", IMMUTABLE)?;
        slice.keys.push(key);
        slice.pack = Vec::new();
    }
    drop(series); // closing the unlinked scratch file frees its disk space
    t.upload += s.elapsed();
    println!("chart series: {} blocks, {:.1} MB, {:.0} s so far", series_tiles.len(), series_bytes as f64 / 1e6, started.elapsed().as_secs_f64());

    let manifest = json!({
        "schema": "openwetter-tiles-3",
        "source": format!("DWD {label} open data, CC BY 4.0 (https://opendata.dwd.de)"),
        "model": model.id, "run": run, "generated_at": unix_now(), "grid": grid_json,
        "tile": TILE, "frames_per_chunk": FRAMES,
        "encoding": {"format": "lossless WebP, grey (R=G=B), frames stacked top to bottom", "nodata": NODATA,
                     "tiles": "[x, y, bytes]; a layer's tiles lie back to back in its pack (layer.pack), chunk by chunk in manifest order, so a tile's offset is the sum of the sizes listed before it"},
        "layers": layers_manifest,
        "series": {"tile": SERIES, "path": "series/{n}.pack", "parts": parts, "tiles": series_tiles, "layers": series_layers,
                   "encoding": "blocks [x, y, bytes] back to back in parts (parts[n] blocks in series/{n}.pack, in order); each block gzip; for each layer in order: frames x h x w uint8 codes (same codes as the map), rows north to south; w, h smaller at the east/south edge"},
    });
    let manifest_key = format!("{}/{run_key}/manifest.json", model.id);
    state.count_uploads(1, max_uploads)?;
    sink.put(&manifest_key, &serde_json::to_vec(&manifest)?, "application/json", IMMUTABLE)?;
    keys.push(manifest_key);

    // Record the run and its history slice, then switch readers over.
    let mut runs: Vec<Value> = runs.into_iter().filter(|r| r["run"] != run.as_str()).collect();
    runs.push(json!({"run": run, "keys": keys, "series_keys": series_keys, "published_at": unix_now()}));
    runs.sort_by(|a, b| a["run"].as_str().cmp(&b["run"].as_str()));
    state.v["runs"] = json!(runs);
    state.v["grid"] = grid_json;
    if model.history {
        let mut history: Vec<Value> = state.v["history"].as_array().cloned().unwrap_or_default();
        history.retain(|h| h["run"] != run.as_str());
        let pack = slice.keys.iter().find(|k| k.ends_with("/slice.pack")).cloned();
        history.push(json!({"run": run, "run_key": run_key, "start": run_start, "keys": slice.keys, "layers": slice.layers, "pack": pack,
                            "series": {"tiles": slice.series_tiles, "layers": slice.series_layers, "offset": slice.series_offset}}));
        history.sort_by_key(|h| h["start"].as_i64());
        state.v["history"] = json!(history);
        write_history_index(&sink, &mut state, max_uploads)?;
    }
    let newest = runs.last().and_then(|r| r["run"].as_str()).unwrap_or(&run).to_owned();
    let mut pointer = json!({"run": newest, "manifest": format!("{}/{}/manifest.json", model.id, newest.replace(':', ""))});
    if let Some(prev) = previous_pointer(model, &runs, &newest) {
        pointer["previous"] = prev;
    }
    state.count_uploads(1, max_uploads)?;
    if model.id == "icon_d2" {
        let mut d2 = pointer;
        d2["history"] = json!("icon_d2/history/index.json");
        let latest = json!({"schema": "openwetter-tiles-2", "generated_at": unix_now(), "icon_d2": d2,
                             "icon_eu": "icon_eu/latest.json", "icon_global": "icon_global/latest.json",
                             "radar": "radar/index.json", "nowcast": "nowcast/index.json", "warnings": "warnings/index.json"});
        sink.put("latest.json", &serde_json::to_vec(&latest)?, "application/json", SHORT)?;
    } else {
        let mut latest = pointer;
        latest["schema"] = json!("openwetter-tiles-2");
        latest["generated_at"] = json!(unix_now());
        sink.put(&format!("{}/latest.json", model.id), &serde_json::to_vec(&latest)?, "application/json", SHORT)?;
    }
    state.save()?;

    // Remove anything under the model's prefix that the state does not reference (e.g. left by a crashed run).
    let swept = sweep(&sink, &format!("{}/", model.id), &referenced_keys(&state, model))?;

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
    /// History series blocks [x, y, bytes], their layers and their start in the pack.
    series_tiles: Vec<Value>,
    series_layers: Vec<Value>,
    series_offset: usize,
    /// The slice's map tiles, then its series blocks: one object per slice.
    pack: Vec<u8>,
}

const HISTORY_SERIES: usize = 64;

/// Append the first HISTORY_MINUTES of every layer per 64 x 64-cell block, assembled from the
/// 32 x 32 blocks of the scratch file, to the slice's pack. Returns (blocks, bytes).
fn history_series(grid: &Grid, series: &SeriesFile, series_layers: &[Value], slice: &mut Slice) -> Res<(usize, usize)> {
    // (global frame offset, frames kept) per layer
    let mut offset = 0;
    let mut parts = Vec::new();
    for l in series_layers {
        let leads: Vec<u64> = l["lead_minutes"].as_array().into_iter().flatten().filter_map(Value::as_u64).collect();
        let n = leads.iter().filter(|&&m| m <= HISTORY_MINUTES as u64).count();
        parts.push((offset, n));
        slice.series_layers.push(json!({"name": l["name"], "frames": n, "step_minutes": l["step_minutes"], "first_step_minutes": l["first_step_minutes"]}));
        offset += leads.len();
    }
    let (width, height) = (grid.width, grid.height);
    let mut frame = vec![0u8; SeriesFile::BLOCK];
    let (mut count, mut bytes) = (0, 0);
    slice.series_offset = slice.pack.len();
    for hy in 0..height.div_ceil(HISTORY_SERIES) {
        for hx in 0..width.div_ceil(HISTORY_SERIES) {
            let (x0, y0) = (hx * HISTORY_SERIES, hy * HISTORY_SERIES);
            let (w, h) = (HISTORY_SERIES.min(width - x0), HISTORY_SERIES.min(height - y0));
            let mut body = Vec::with_capacity(parts.iter().map(|p| p.1).sum::<usize>() * w * h);
            for &(off, n) in &parts {
                for f in 0..n {
                    let start = body.len();
                    body.resize(start + w * h, NODATA);
                    // Copy from each 32-block overlapping this 64-block.
                    for sy in y0 / SERIES..(y0 + h).div_ceil(SERIES) {
                        for sx in x0 / SERIES..(x0 + w).div_ceil(SERIES) {
                            let (sw, sh) = (SERIES.min(width - sx * SERIES), SERIES.min(height - sy * SERIES));
                            let b = sy * series.bx + sx;
                            series.file.read_exact_at(&mut frame, ((b * series.total_frames + off + f) * SeriesFile::BLOCK) as u64)?;
                            for r in 0..sh {
                                let gy = sy * SERIES + r;
                                let dst = start + (gy - y0) * w + (sx * SERIES - x0);
                                body[dst..dst + sw].copy_from_slice(&frame[r * sw..r * sw + sw]);
                            }
                        }
                    }
                }
            }
            if body.iter().all(|&v| v == NODATA) {
                continue;
            }
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
            gz.write_all(&body)?;
            let gz = gz.finish()?;
            bytes += gz.len();
            count += 1;
            slice.series_tiles.push(json!([hx, hy, gz.len()]));
            slice.pack.extend_from_slice(&gz);
        }
    }
    slice.bytes += bytes;
    Ok((count, bytes))
}

/// Every object key the state references under the model's prefix.
fn referenced_keys(state: &State, model: &Model) -> std::collections::HashSet<String> {
    let mut keep = std::collections::HashSet::from([format!("{}/history/index.json", model.id), format!("{}/latest.json", model.id)]);
    let lists = state.v["runs"].as_array().into_iter().flatten().flat_map(|r| [&r["keys"], &r["series_keys"]])
        .chain(state.v["history"].as_array().into_iter().flatten().map(|h| &h["keys"]));
    for list in lists {
        keep.extend(list.as_array().into_iter().flatten().filter_map(|k| k.as_str().map(str::to_owned)));
    }
    keep
}

/// Delete superseded runs once their successor has been live for the grace period, and history
/// slices older than `history_days`. Returns the number of deleted objects.
/// How long a replaced run's chart series is kept (the "previous day's forecast" comparison).
const PREVIOUS_SECONDS: i64 = 24 * 3600;

/// Pointer to the run started 24 hours before `newest`, if its series is still kept.
fn previous_pointer(model: &Model, runs: &[Value], newest: &str) -> Option<Value> {
    let want = parse_iso(&format!("{newest}:00"))? - PREVIOUS_SECONDS;
    let prev = runs.iter().find(|r| run_start_of(r) == Some(want) && r["series_keys"].as_array().is_some_and(|k| !k.is_empty()))?;
    let run = prev["run"].as_str()?;
    Some(json!({"run": run, "manifest": format!("{}/{}/manifest.json", model.id, run.replace(':', ""))}))
}

fn run_start_of(r: &Value) -> Option<i64> {
    r["run"].as_str().and_then(|run| parse_iso(&format!("{run}:00")))
}

fn housekeeping(sink: &Sink, state: &mut State, grace_minutes: i64, history_days: i64) -> Res<usize> {
    let now = unix_now();
    let mut runs: Vec<Value> = state.v["runs"].as_array().cloned().unwrap_or_default();
    runs.sort_by(|a, b| a["run"].as_str().cmp(&b["run"].as_str()));
    let mut doomed: Vec<String> = Vec::new();
    let successors: Vec<i64> = runs.iter().skip(1).map(|r| r["published_at"].as_i64().unwrap_or(0)).collect();
    let newest_start = runs.last().and_then(run_start_of);
    let mut kept = Vec::new();
    for (i, mut r) in runs.into_iter().enumerate() {
        let superseded = successors.get(i).is_some_and(|&p| now - p >= grace_minutes * 60);
        if !superseded {
            kept.push(r);
            continue;
        }
        // A replaced run's chart series and manifest stay until it is a day older than the
        // newest run: the graphs compare with the forecast made 24 hours earlier.
        let keep_series = matches!((newest_start, run_start_of(&r)), (Some(n), Some(s)) if n - s <= PREVIOUS_SECONDS);
        let keys: Vec<String> = r["keys"].as_array().into_iter().flatten().filter_map(|k| k.as_str().map(str::to_owned)).collect();
        if keep_series {
            let (manifest, tiles): (Vec<String>, Vec<String>) = keys.into_iter().partition(|k| k.ends_with("/manifest.json"));
            doomed.extend(tiles);
            r["keys"] = json!(manifest);
            kept.push(r);
        } else {
            doomed.extend(keys);
            doomed.extend(r["series_keys"].as_array().into_iter().flatten().filter_map(|k| k.as_str().map(str::to_owned)));
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
    let codes: Map<String, Value> = JOBS.iter().filter(|j| j.only.is_none()).flat_map(|j| j.layers.iter()).map(|l| (l.name.to_owned(), l.code.describe())).collect();
    let slices: Vec<Value> = state.v["history"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .map(|h| json!({"run": h["run"], "run_key": h["run_key"], "start": h["start"], "layers": h["layers"], "series": h["series"], "pack": h["pack"]}))
        .collect();
    let index = json!({
        "schema": "openwetter-history-2",
        "source": "DWD ICON-D2 open data, CC BY 4.0 (https://opendata.dwd.de)",
        "generated_at": unix_now(), "grid": state.v["grid"], "tile": HISTORY_TILE,
        "path": "icon_d2/history/{run_key}/{layer}/{x}_{y}.webp",
        "encoding": "lossless WebP, grey (R=G=B), frames stacked top to bottom; per layer: frames from first_step_minutes after the run, every step_minutes; codes as in the run manifest. Slices with a pack: each layer's tiles [x, y, bytes] lie back to back from the layer's offset, the series blocks from series.offset; older slices: one file per tile at path",
        "codes": codes, "slices": slices,
        "series": {"tile": HISTORY_SERIES, "path": "icon_d2/history/{run_key}/series/{x}_{y}.bin.gz",
                   "encoding": "gzip; for each layer of the slice in order: frames x h x w uint8 codes (as in the run manifest), rows north to south; w, h smaller at the east/south edge"},
    });
    if max_uploads != u64::MAX {
        state.count_uploads(1, max_uploads)?;
    }
    sink.put("icon_d2/history/index.json", &serde_json::to_vec(&index)?, "application/json", SHORT)
}


/// Download, regrid, quantise, encode and upload every chunk of one job's layers.
#[allow(clippy::too_many_arguments)]
fn publish_job(
    model: &Model,
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
    let (leads, steps) = model.frames(job);
    let step_minutes = steps[0];
    let plane = grid.width * grid.height;
    let nl = job.layers.len();
    let nf = job.fields.len();
    let mut frames = vec![NODATA; plane * FRAMES * nl];
    // Previous accumulated values per field (accumulation is zero at the run start; a schedule
    // starting later, as ICON Global's, reads the lead time before its first frame).
    let mut previous: Vec<Option<Vec<f32>>> = vec![None; nf];
    let before = leads[0] - steps[0];
    if job.accumulated && before > 0 {
        for (f, field) in job.fields.iter().enumerate() {
            previous[f] = Some(grid.gather(decode(&fetch(agent, &model.field_url(run_enc, field, before), t)?, t)?)?);
        }
    }
    let mut rgb = Vec::new();
    let mut chunks: Vec<Vec<Value>> = vec![Vec::new(); nl];
    // One object per layer: its tiles back to back, chunk by chunk in manifest order.
    let mut packs: Vec<Vec<u8>> = vec![Vec::new(); nl];
    let mut bytes_total = 0;
    let mut cell = vec![0f32; nf];

    for (chunk, range) in chunk_ranges(&steps).into_iter().enumerate() {
        frames.fill(NODATA);
        let chunk_leads = &leads[range.clone()];
        let chunk_minutes = steps[range.start];
        for (k, &lead) in chunk_leads.iter().enumerate() {
            let hours = steps[range.start + k] as f32 / 60.0;
            let mut current = Vec::with_capacity(nf);
            for field in job.fields {
                current.push(grid.gather(decode(&fetch(agent, &model.field_url(run_enc, field, lead), t)?, t)?)?);
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
                    frames[(l * FRAMES + k) * plane + px] = layer.code.quantise(layer.code.value(&cell, hours));
                }
            }
            for l in 0..nl {
                let g = layer_offset + l * leads.len() + range.start + k;
                series.write_frame(&frames[(l * FRAMES + k) * plane..(l * FRAMES + k + 1) * plane], grid.width, grid.height, g)?;
            }
            t.regrid += s.elapsed();
            if job.accumulated {
                previous = current.into_iter().map(Some).collect();
            }
        }

        if job.series_only {
            continue; // chart series only: no map tiles, no history slice
        }
        if chunk == 0 && model.history {
            // History slice: the first 3 hours of each layer, in larger tiles (few objects per run).
            let n = HISTORY_MINUTES / step_minutes;
            for (l, layer) in job.layers.iter().enumerate() {
                let layer_frames = &frames[l * FRAMES * plane..(l * FRAMES + n) * plane];
                let (offset, mut tiles) = (slice.pack.len(), Vec::new());
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
                        slice.pack.extend_from_slice(&webp);
                    }
                }
                slice.layers.insert(layer.name.to_owned(), json!({"step_minutes": step_minutes, "first_step_minutes": chunk_leads[0],
                                                                  "frames": n, "tiles": tiles, "offset": offset}));
            }
        }
        for (l, layer) in job.layers.iter().enumerate() {
            let layer_frames = &frames[l * FRAMES * plane..(l + 1) * FRAMES * plane];
            let mut tiles = Vec::new();
            for ty in 0..grid.height.div_ceil(TILE) {
                for tx in 0..grid.width.div_ceil(TILE) {
                    let (w, h, data, nonzero) = tile_rgb(layer_frames, chunk_leads.len(), grid.width, grid.height, TILE, tx, ty, &mut rgb);
                    if !data || (layer.code == Code::LogRate && !nonzero) {
                        continue; // outside the model, or dry rain/snow for the whole chunk
                    }
                    let s = Instant::now();
                    let webp = encode_lossless(&rgb, w as u32, (h * chunk_leads.len()) as u32)?;
                    t.encode += s.elapsed();
                    tiles.push(json!([tx, ty, webp.len()]));
                    bytes_total += webp.len();
                    packs[l].extend_from_slice(&webp);
                }
            }
            chunks[l].push(json!({"chunk": chunk, "first_step_minutes": chunk_leads[0], "step_minutes": chunk_minutes,
                                  "frames": chunk_leads.len(), "tiles": tiles}));
        }
    }

    if job.series_only {
        return Ok((0, Vec::new()));
    }
    let batch: Vec<(String, Vec<u8>)> = job.layers.iter().zip(packs)
        .map(|(layer, pack)| (format!("{}/{run_key}/{}.pack", model.id, layer.name), pack)).collect();
    state.count_uploads(batch.len() as u64, max_uploads)?;
    let s = Instant::now();
    sink.put_many(&batch, "application/octet-stream", IMMUTABLE)?;
    t.upload += s.elapsed();
    keys.extend(batch.into_iter().map(|(k, _)| k));
    let entries = job
        .layers
        .iter()
        .zip(chunks)
        .map(|(layer, chunk_list)| {
            (layer.name.to_owned(), json!({
                "step_minutes": step_minutes,
                "fields": job.fields,
                "missing_tile": if layer.code == Code::LogRate { "dry for the whole chunk, or outside the model" } else { "outside the model" },
                "pack": format!("{}.pack", layer.name),
                "code": layer.code.describe(),
                "chunks": chunk_list,
            }))
        })
        .collect();
    Ok((bytes_total, entries))
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

/// Newest run (of the model's run hours) whose last file is published for every field.
fn latest_complete_run(agent: &ureq::Agent, model: &Model) -> Res<String> {
    let mut runs: Vec<String> = listing(agent, &format!("{}TOT_PREC/r/", model.root))?
        .into_iter()
        .map(|h| h.trim_end_matches('/').to_owned())
        .filter(|h| h.len() == 16 && h.as_bytes()[10] == b'T')
        .filter(|h| h[11..13].parse::<u32>().is_ok_and(|hour| model.run_hours.contains(&hour)))
        .collect();
    runs.sort();
    'runs: for run in runs.iter().rev() {
        let enc = run.replace(':', "%3A");
        for field in jobs(model).flat_map(|j| j.fields.iter()).chain(["CLAT", "CLON"].iter()) {
            let lead = if *field == "CLAT" || *field == "CLON" { 0 } else { model.last_lead() };
            if agent.head(&model.field_url(&enc, field, lead)).call()?.status() != 200 {
                continue 'runs;
            }
        }
        return Ok(run.clone());
    }
    Err(format!("no complete {} run yet", model.label).into())
}

/// Regular lat/lon output grid with a nearest-native-cell index per pixel.
struct Grid {
    west: f64,
    north: f64,
    width: usize,
    height: usize,
    /// Position in a gathered field (see `gather`) for each output pixel (row 0 = north);
    /// u32::MAX = outside the model.
    index: Vec<u32>,
    /// Native cells the output grid uses, ascending. Fields are reduced to these right after
    /// decoding, so a whole-planet ICON Global field (2.9 million cells) is not kept.
    used: Vec<u32>,
}

impl Grid {
    fn build(lat: &[f32], mut lon: Vec<f32>, model: &Model) -> Grid {
        // Longitudes as -180..180 (the global mesh may use 0..360).
        lon.iter_mut().filter(|x| **x > 180.0).for_each(|x| *x -= 360.0);
        let lon = &lon[..];
        let fold = |f: fn(f32, f32) -> f32, v: &[f32], init: f32| v.iter().copied().filter(|x| x.is_finite()).fold(init, f);
        let [south, north, west, east] = model.bbox.unwrap_or_else(|| [
            fold(f32::min, lat, f32::MAX) as f64, fold(f32::max, lat, f32::MIN) as f64,
            fold(f32::min, lon, f32::MAX) as f64, fold(f32::max, lon, f32::MIN) as f64,
        ]);
        let (lat_step, lon_step, cutoff) = (model.lat_step, model.lon_step, model.cutoff);
        let width = ((east - west) / lon_step).floor() as usize + 1;
        let height = ((north - south) / lat_step).floor() as usize + 1;
        let scale = libm::cos(51.5f64.to_radians());

        // Only native cells near the output grid take part (the global mesh has 2.9 million).
        let margin = 2.0 * cutoff;
        let near: Vec<u32> = (0..lat.len() as u32)
            .filter(|&i| {
                let (la, lo) = (lat[i as usize] as f64, lon[i as usize] as f64);
                la.is_finite() && lo.is_finite() && la >= south - margin && la <= north + margin && lo >= west - margin / scale && lo <= east + margin / scale
            })
            .collect();

        // Bucket the native cells on a coarse grid so each pixel searches only 3x3 buckets.
        let b = cutoff;
        let bw = ((east - west) * scale / b).ceil() as usize + 1;
        let bh = ((north - south) / b).ceil() as usize + 1;
        let bucket_of = |la: f64, lo: f64| {
            let bx = (((lo - west) * scale) / b).max(0.0) as usize;
            let by = ((la - south) / b).max(0.0) as usize;
            by.min(bh - 1) * bw + bx.min(bw - 1)
        };
        let mut counts = vec![0u32; bw * bh + 1];
        for &i in &near {
            counts[bucket_of(lat[i as usize] as f64, lon[i as usize] as f64) + 1] += 1;
        }
        for i in 1..counts.len() {
            counts[i] += counts[i - 1];
        }
        let mut fill = counts.clone();
        let mut members = vec![0u32; near.len()];
        for &i in &near {
            let k = bucket_of(lat[i as usize] as f64, lon[i as usize] as f64);
            members[fill[k] as usize] = i;
            fill[k] += 1;
        }
        drop(fill);

        let mut index = vec![u32::MAX; width * height];
        for row in 0..height {
            let la = north - row as f64 * lat_step;
            for col in 0..width {
                let lo = west + col as f64 * lon_step;
                let bx = (((lo - west) * scale) / b) as isize;
                let by = ((la - south) / b) as isize;
                let mut best = (cutoff * cutoff, u32::MAX);
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
        let mut used: Vec<u32> = index.iter().copied().filter(|&c| c != u32::MAX).collect();
        used.sort_unstable();
        used.dedup();
        for c in index.iter_mut().filter(|c| **c != u32::MAX) {
            *c = used.binary_search(c).unwrap() as u32;
        }
        Grid { west, north, width, height, index, used }
    }

    /// The values of the native cells this grid uses, in `used` order.
    fn gather(&self, field: Vec<f32>) -> Res<Vec<f32>> {
        let need = self.used.last().map_or(0, |&c| c as usize + 1);
        if field.len() < need {
            return Err(format!("field has {} cells, the mesh needs {need}", field.len()).into());
        }
        Ok(self.used.iter().map(|&c| field[c as usize]).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(hourly: bool) -> Job {
        Job { fields: &["X"], hourly, accumulated: true, layers: &[], only: None, series_only: false }
    }

    #[test]
    fn icon_d2_schedule_is_unchanged() {
        let d2 = Model::find("icon_d2").unwrap();
        let (leads, steps) = d2.frames(&job(false));
        assert_eq!((leads.len(), leads[0], *leads.last().unwrap()), (192, 15, 2880));
        assert!(steps.iter().all(|&s| s == 15));
        let ranges = chunk_ranges(&steps);
        assert_eq!(ranges.len(), 8);
        assert!(ranges.iter().all(|r| r.len() == FRAMES));
        let (leads, _) = d2.frames(&job(true));
        assert_eq!((leads.len(), leads[0]), (48, 60));
    }

    #[test]
    fn icon_eu_chunks_never_mix_hourly_and_three_hourly_frames() {
        let eu = Model::find("icon_eu").unwrap();
        let (leads, steps) = eu.frames(&job(true));
        assert_eq!(leads.len(), 78 + 14);
        assert_eq!(steps[77], 60);
        assert_eq!((leads[78], steps[78]), (81 * 60, 180), "81 h covers 78-81 h");
        let lens: Vec<usize> = chunk_ranges(&steps).iter().map(|r| r.len()).collect();
        assert_eq!(lens, vec![24, 24, 24, 6, 14]);
        assert_eq!(eu.last_lead(), 120 * 60);
    }

    #[test]
    fn icon_global_starts_late_and_reads_the_lead_before_for_accumulations() {
        let g = Model::find("icon_global").unwrap();
        let (leads, steps) = g.frames(&job(false));
        assert_eq!((leads[0], steps[0], leads.len()), (111 * 60, 180, 24));
        assert_eq!(leads[0] - steps[0], 108 * 60);
        assert_eq!(g.field_url("r", "TOT_PREC", 111 * 60), "https://opendata.dwd.de/weather/nwp/v1/m/icon/p/TOT_PREC/r/r/s/PT111H00M.grib2");
        assert!(Model::find("gfs").is_err());
    }

    #[test]
    fn replaced_runs_keep_series_and_manifest_for_a_day_and_the_pointer_names_the_run_24_hours_older() {
        let dir = std::env::temp_dir().join(format!("ow-hk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let sink = Sink::from_args(false, Some(dir.join("out").display().to_string())).unwrap();
        let run = |h: u32| format!("2026-11-{:02}T{:02}:00", 5 + h / 24, h % 24);
        // Runs every 3 h over 30 h, all published long ago (grace passed).
        let runs: Vec<Value> = (0..=10).map(|i| {
            let r = run(i * 3);
            let k = r.replace(':', "");
            json!({"run": r, "keys": [format!("icon_d2/{k}/manifest.json"), format!("icon_d2/{k}/precip/c00/0_0.webp")],
                   "series_keys": [format!("icon_d2/{k}/series/0_0.bin.gz")], "published_at": 0})
        }).collect();
        let state_path = dir.join("state.json");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&state_path, serde_json::to_vec(&json!({"runs": runs, "history": []})).unwrap()).unwrap();
        let mut state = State::load(&state_path, json!({})).unwrap();
        housekeeping(&sink, &mut state, 30, 5).unwrap();
        let kept: Vec<(String, usize, usize)> = state.v["runs"].as_array().unwrap().iter()
            .map(|r| (r["run"].as_str().unwrap().to_owned(), r["keys"].as_array().unwrap().len(), r["series_keys"].as_array().unwrap().len())).collect();
        // Newest 30 h; kept: runs at most 24 h older (from 6 h), tiles dropped except the newest.
        assert_eq!(kept.first().unwrap(), &(run(6), 1, 1), "24 h older: manifest + series only");
        assert_eq!(kept.last().unwrap(), &(run(30), 2, 1), "newest untouched");
        assert_eq!(kept.len(), 9, "runs 0 h and 3 h are deleted");
        let d2 = Model::find("icon_d2").unwrap();
        let p = previous_pointer(d2, state.v["runs"].as_array().unwrap(), &run(30)).unwrap();
        assert_eq!(p["manifest"], json!("icon_d2/2026-11-05T0600/manifest.json"));
        assert!(previous_pointer(d2, state.v["runs"].as_array().unwrap(), &run(27)).is_none(), "the run 24 h before 27 h (3 h) was deleted");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rain_rate_divides_by_the_period() {
        assert_eq!(Code::LogRate.value(&[1.5], 3.0), 0.5);
        assert_eq!(Code::LogRate.value(&[0.25], 0.25), 1.0);
    }
}
