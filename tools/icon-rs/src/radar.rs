//! Observed DWD radar (RADOLAN RY, 5 min, 1 km) for the past two days, and the DWD radar
//! nowcast (RADVOR RV, 5-minute rain amounts for the next two hours).
//!
//! Both arrive as HDF5 files whose whole 1100 x 1200 grid is one deflate-compressed chunk, so
//! a tiny reader finds that zlib stream instead of linking the HDF5 C library. Values are
//! reprojected from DWD's polar-stereographic 1 km grid onto a regular lat/lon grid (nearest
//! cell), coded with the same 8-bit log rain rate as ICON rain and written as lossless WebP
//! tiles of 512 x 512 cells.
//!
//! Radar: every new 5-minute scan is published as single-frame tiles; once a 2-hour block is
//! complete its 24 frames are merged into one stacked tile set and the single frames deleted.
//! `radar/index.json` lists the merged blocks and the recent single frames.
//! Nowcast: each new 2-hour forecast replaces the previous one (`nowcast/index.json`).

use std::{io::Read, path::PathBuf, time::Instant};

use serde_json::{Value, json};

use crate::common::*;

const RY_URL: &str = "https://opendata.dwd.de/weather/radar/radolan/ry/";
const RV_URL: &str = "https://opendata.dwd.de/weather/radar/composite/rv/";
const NX: usize = 1100; // native radar columns
const NY: usize = 1200; // native radar rows
pub const WEST: f64 = 1.47;
pub const NORTH: f64 = 56.22;
pub const LON_STEP: f64 = 0.015; // ~1.04 km at 51.5 N
pub const LAT_STEP: f64 = 0.01; // ~1.11 km
pub const WIDTH: usize = 1151;
pub const HEIGHT: usize = 1054;
// libwebp needs ~22 bytes per pixel while encoding, so stacked tiles stay small (256 x 6144 px
// ~ 45 MB) and single scans are one whole-grid image (~35 MB).
const TILE: usize = 256;
const FRAME_TILE: usize = 2048;
const NOWCAST_EVERY: i64 = 900;
const STEP: i64 = 300;
const BLOCK: i64 = 7200; // 2 hours = 24 frames
const FRAMES: usize = 24;
const KEEP_SECONDS: i64 = 48 * 3600;

fn grid_json() -> Value {
    json!({"west": WEST, "north": NORTH, "lon_step": LON_STEP, "lat_step": LAT_STEP,
           "width": WIDTH, "height": HEIGHT, "row0": "north"})
}

/// Native radar cell (row * NX + col) for each output pixel; u32::MAX = outside the composite.
///
/// DWD projection: +proj=stere +lat_0=90 +lat_ts=60 +lon_0=10 +a=6378137 +b=6356752.3142451802
/// +x_0=543196.83521776402 +y_0=3622588.8619310018; pixel centre (col, row) is at
/// x = col * 1000 m, y = -row * 1000 m (row 0 = north).
#[allow(clippy::excessive_precision)] // constants copied verbatim from the DWD projdef
pub fn radar_index() -> Vec<u32> {
    let a = 6_378_137.0f64;
    let b = 6_356_752.314_245_180_2f64;
    let e = libm::sqrt(1.0 - (b * b) / (a * a));
    let (x0, y0) = (543_196.835_217_764_02f64, 3_622_588.861_931_001_8f64);
    let lon0 = 10f64.to_radians();
    let t = |phi: f64| {
        let s = libm::sin(phi);
        libm::tan(std::f64::consts::FRAC_PI_4 - phi / 2.0) / libm::pow((1.0 - e * s) / (1.0 + e * s), e / 2.0)
    };
    let phic = 60f64.to_radians();
    let mc = libm::cos(phic) / libm::sqrt(1.0 - e * e * libm::sin(phic) * libm::sin(phic));
    let tc = t(phic);
    let mut index = vec![u32::MAX; WIDTH * HEIGHT];
    for row in 0..HEIGHT {
        let phi = (NORTH - row as f64 * LAT_STEP).to_radians();
        let rho = a * mc * t(phi) / tc;
        for col in 0..WIDTH {
            let lam = (WEST + col as f64 * LON_STEP).to_radians() - lon0;
            let x = rho * libm::sin(lam) + x0;
            let y = -rho * libm::cos(lam) + y0;
            let (c, r) = (libm::round(x / 1000.0), libm::round(-y / 1000.0));
            if c >= 0.0 && r >= 0.0 && (c as usize) < NX && (r as usize) < NY {
                index[row * WIDTH + col] = (r as usize * NX + c as usize) as u32;
            }
        }
    }
    index
}

/// Find the single deflate-compressed dataset chunk of `expected` bytes inside an HDF5 file.
pub fn hdf5_single_chunk(bytes: &[u8], expected: usize) -> Res<Vec<u8>> {
    let mut out = vec![0u8; expected];
    for i in 0..bytes.len().saturating_sub(2) {
        if bytes[i] != 0x78 || !((0x78u16 << 8) | bytes[i + 1] as u16).is_multiple_of(31) {
            continue;
        }
        let mut z = flate2::Decompress::new(true);
        if let Ok(flate2::Status::StreamEnd) = z.decompress(&bytes[i..], &mut out, flate2::FlushDecompress::Finish)
            && z.total_out() as usize == expected
        {
            return Ok(out);
        }
    }
    Err(format!("no compressed {expected}-byte dataset found in HDF5 file").into())
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// RADOLAN RY: rain rate in mm/h per native cell (NaN = no data).
fn decode_ry(bytes: &[u8]) -> Res<Vec<f32>> {
    if !contains(bytes, b"RATE") || !contains(bytes, b"RY") {
        return Err("not a RADOLAN RY RATE file".into());
    }
    let raw = hdf5_single_chunk(bytes, NX * NY * 2)?;
    Ok(raw
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| match u16::from_le_bytes(*c) {
            65535 => f32::NAN,
            v => v as f32 * 0.01,
        })
        .collect())
}

/// RADVOR RV: 5-minute rain amount (ACRR, mm) per native cell as mm/h (NaN = no data).
fn decode_rv(bytes: &[u8]) -> Res<Vec<f32>> {
    if !contains(bytes, b"ACRR") {
        return Err("not a RADVOR RV ACRR file".into());
    }
    let raw = hdf5_single_chunk(bytes, NX * NY * 4)?;
    Ok(raw
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| match u32::from_le_bytes(*c) {
            u32::MAX => f32::NAN,
            v => ((v as f64 * 0.001 - 0.001).max(0.0) * 12.0) as f32,
        })
        .collect())
}

fn regrid(values: &[f32], index: &[u32], frame: &mut [u8]) {
    for (px, &c) in index.iter().enumerate() {
        frame[px] = if c == u32::MAX { NODATA } else { log_rate_code(values[c as usize]) };
    }
}

/// Encode `nframes` stacked frames as 512-cell tiles; dry or empty tiles are skipped.
type Batch = Vec<(String, Vec<u8>)>;

fn encode_tiles(frames: &[u8], nframes: usize, prefix: &str, tile: usize) -> Res<(Batch, Vec<Value>)> {
    let mut rgb = Vec::new();
    let (mut batch, mut tiles) = (Vec::new(), Vec::new());
    for ty in 0..HEIGHT.div_ceil(tile) {
        for tx in 0..WIDTH.div_ceil(tile) {
            let (w, h, _data, nonzero) = tile_rgb(frames, nframes, WIDTH, HEIGHT, tile, tx, ty, &mut rgb);
            if !nonzero {
                continue; // dry everywhere (or outside the composite) for these frames
            }
            let webp = encode_lossless(&rgb, w as u32, (h * nframes) as u32)?;
            tiles.push(json!([tx, ty, webp.len()]));
            batch.push((format!("{prefix}/{tx}_{ty}.webp"), webp));
        }
    }
    Ok((batch, tiles))
}

fn tile_keys(prefix: &str, tiles: &Value) -> Vec<String> {
    tiles
        .as_array()
        .map(|a| a.iter().map(|t| format!("{prefix}/{}_{}.webp", t[0], t[1])).collect())
        .unwrap_or_default()
}

/// RY file name "raa01-ry_10000-YYMMDDHHMM-dwd---bin.hdf5" -> (unix time, name).
fn ry_files(agent: &ureq::Agent) -> Res<Vec<(i64, String)>> {
    let mut out = Vec::new();
    for name in listing(agent, RY_URL)? {
        if let Some(stamp) = name.strip_prefix("raa01-ry_10000-").and_then(|s| s.strip_suffix("-dwd---bin.hdf5")) {
            let n = |a: usize| stamp.get(a..a + 2).and_then(|s| s.parse::<i64>().ok());
            if let (Some(y), Some(mo), Some(d), Some(h), Some(mi)) = (n(0), n(2), n(4), n(6), n(8)) {
                out.push((days_from_civil(2000 + y, mo, d) * 86_400 + h * 3600 + mi * 60, name));
            }
        }
    }
    out.sort();
    Ok(out)
}

pub fn run_radar(args: &[String]) -> Res<()> {
    let max_uploads: u64 = arg(args, "--max-uploads-month").map(|v| v.parse()).transpose()?.unwrap_or(150_000);
    let state_path = PathBuf::from(arg(args, "--state").unwrap_or_else(|| "openwetter-radar-state.json".into()));
    let sink = Sink::from_args(flag(args, "--publish"), arg(args, "--out"))?;
    let agent = agent();
    let started = Instant::now();
    let mut state = State::load(&state_path, json!({"chunks": [], "frames": [], "month": "", "uploads": 0}))?;

    let files = ry_files(&agent)?;
    let newest = files.last().ok_or("DWD RY directory is empty")?.0;
    let window_start = (newest - KEEP_SECONDS).div_euclid(BLOCK) * BLOCK;
    let by_time: std::collections::BTreeMap<i64, String> = files.into_iter().filter(|(t, _)| *t >= window_start).collect();
    let index = radar_index();
    let plane = WIDTH * HEIGHT;
    let mut chunks: Vec<Value> = state.v["chunks"].as_array().cloned().unwrap_or_default();
    let mut singles: Vec<Value> = state.v["frames"].as_array().cloned().unwrap_or_default();
    let (mut made_chunks, mut made_frames) = (0, 0);

    // 1. Merge every complete 2-hour block that is not published yet.
    let current_block = newest.div_euclid(BLOCK) * BLOCK;
    let mut start = window_start;
    while start < current_block {
        if !chunks.iter().any(|c| c["start"] == start) {
            let mut frames = vec![NODATA; plane * FRAMES];
            let mut missing = Vec::new();
            for i in 0..FRAMES {
                let t = start + i as i64 * STEP;
                match by_time.get(&t) {
                    Some(name) => regrid(&decode_ry(&get(&agent, &format!("{RY_URL}{name}"))?)?, &index, &mut frames[i * plane..(i + 1) * plane]),
                    None => missing.push(i),
                }
            }
            let prefix = format!("radar/c/{start}");
            let (batch, tiles) = encode_tiles(&frames, FRAMES, &prefix, TILE)?;
            state.count_uploads(batch.len() as u64, max_uploads)?;
            sink.put_many(&batch, "image/webp", IMMUTABLE)?;
            chunks.push(json!({"start": start, "frames": FRAMES, "tile": TILE, "path": format!("{prefix}/{{x}}_{{y}}.webp"),
                               "tiles": tiles, "missing_frames": missing}));
            made_chunks += 1;
            // Single frames of this block are now redundant.
            let (old, keep): (Vec<Value>, Vec<Value>) = singles.into_iter().partition(|f| {
                f["time"].as_i64().is_some_and(|t| t >= start && t < start + BLOCK)
            });
            singles = keep;
            for f in old {
                for key in tile_keys(&format!("radar/f/{}", f["time"]), &f["tiles"]) {
                    sink.delete(&key)?;
                }
            }
            state.v["chunks"] = json!(chunks);
            state.v["frames"] = json!(singles);
            state.save()?;
        }
        start += BLOCK;
    }

    // 2. Publish new scans of the current, incomplete block as single frames.
    for (&t, name) in by_time.range(current_block..) {
        if singles.iter().any(|f| f["time"] == t) {
            continue;
        }
        let mut frame = vec![NODATA; plane];
        regrid(&decode_ry(&get(&agent, &format!("{RY_URL}{name}"))?)?, &index, &mut frame);
        let prefix = format!("radar/f/{t}");
        let (batch, tiles) = encode_tiles(&frame, 1, &prefix, FRAME_TILE)?;
        state.count_uploads(batch.len() as u64, max_uploads)?;
        sink.put_many(&batch, "image/webp", IMMUTABLE)?;
        singles.push(json!({"time": t, "tile": FRAME_TILE, "path": format!("{prefix}/{{x}}_{{y}}.webp"), "tiles": tiles}));
        made_frames += 1;
    }

    // 3. Drop blocks that left the two-day window.
    let (old, keep): (Vec<Value>, Vec<Value>) = chunks.into_iter().partition(|c| c["start"].as_i64().is_some_and(|s| s < window_start));
    chunks = keep;
    for c in &old {
        for key in tile_keys(&format!("radar/c/{}", c["start"]), &c["tiles"]) {
            sink.delete(&key)?;
        }
    }
    chunks.sort_by_key(|c| c["start"].as_i64());
    singles.sort_by_key(|f| f["time"].as_i64());

    if made_chunks + made_frames + old.len() > 0 {
        let index_json = json!({
            "schema": "openwetter-radar-1",
            "product": "DWD RADOLAN RY observed rain rate, 5 min, 1 km (CC BY 4.0, https://opendata.dwd.de)",
            "generated_at": unix_now(), "grid": grid_json(), "tile": TILE, "step_seconds": STEP,
            "latest": singles.last().and_then(|f| f["time"].as_i64()).or_else(|| chunks.last().and_then(|c| c["start"].as_i64().map(|s| s + BLOCK - STEP))),
            "code": log_rate_describe(), "chunks": chunks, "frames": singles,
        });
        state.count_uploads(1, max_uploads)?;
        sink.put("radar/index.json", &serde_json::to_vec(&index_json)?, "application/json", SHORT)?;
    }
    state.v["chunks"] = json!(chunks);
    state.v["frames"] = json!(singles);
    state.save()?;
    // Once per merged block: remove radar objects the state does not reference (crash leftovers).
    let mut swept = 0;
    if made_chunks > 0 {
        let mut keep: std::collections::HashSet<String> = std::collections::HashSet::from(["radar/index.json".to_owned()]);
        for c in &chunks {
            keep.extend(tile_keys(&format!("radar/c/{}", c["start"]), &c["tiles"]));
        }
        for f in &singles {
            keep.extend(tile_keys(&format!("radar/f/{}", f["time"]), &f["tiles"]));
        }
        swept = sweep(&sink, "radar/", &keep)?;
    }
    println!(
        "radar: {swept} orphaned objects swept; newest scan {newest}, {made_chunks} blocks merged, {made_frames} new frames, {} old blocks deleted, {:.1} s; uploads this month {}",
        old.len(), started.elapsed().as_secs_f64(), state.uploads()
    );
    Ok(())
}

pub fn run_nowcast(args: &[String]) -> Res<()> {
    let max_uploads: u64 = arg(args, "--max-uploads-month").map(|v| v.parse()).transpose()?.unwrap_or(100_000);
    let state_path = PathBuf::from(arg(args, "--state").unwrap_or_else(|| "openwetter-nowcast-state.json".into()));
    let sink = Sink::from_args(flag(args, "--publish"), arg(args, "--out"))?;
    let agent = agent();
    let started = Instant::now();
    let mut state = State::load(&state_path, json!({"issued": null, "tiles": [], "month": "", "uploads": 0}))?;

    // Newest "composite_rv_YYYYMMDD_HHMM.tar".
    let mut issues: Vec<(i64, String)> = listing(&agent, RV_URL)?
        .into_iter()
        .filter_map(|name| {
            let s = name.strip_prefix("composite_rv_")?.strip_suffix(".tar")?;
            let n = |a: usize, l: usize| s.get(a..a + l)?.parse::<i64>().ok();
            let t = days_from_civil(n(0, 4)?, n(4, 2)?, n(6, 2)?) * 86_400 + n(9, 2)? * 3600 + n(11, 2)? * 60;
            Some((t, name))
        })
        .collect();
    issues.sort();
    let (issued, name) = issues.pop().ok_or("no RADVOR RV forecast found")?;
    if let Some(prev) = state.v["issued"].as_i64()
        && issued - prev < NOWCAST_EVERY
        && !flag(args, "--force")
    {
        println!("nowcast: issue {issued} skipped; {prev} is less than {} min old", NOWCAST_EVERY / 60);
        return Ok(());
    }

    let tar_bytes = get(&agent, &format!("{RV_URL}{name}"))?;
    let index = radar_index();
    let plane = WIDTH * HEIGHT;
    let mut frames = vec![NODATA; plane * FRAMES];
    let mut found = 0;
    let mut archive = tar::Archive::new(&tar_bytes[..]);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_string_lossy().into_owned();
        // ..._NNN-hd5 where NNN = minutes after issue at the end of the 5-minute amount.
        let lead: Option<usize> = path.strip_suffix("-hd5").and_then(|p| p.rsplit('_').next()).and_then(|n| n.parse().ok());
        let Some(lead) = lead.filter(|l| *l >= 5 && *l <= 120 && l % 5 == 0) else { continue };
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        let i = lead / 5 - 1;
        regrid(&decode_rv(&bytes)?, &index, &mut frames[i * plane..(i + 1) * plane]);
        found += 1;
    }
    if found != FRAMES {
        return Err(format!("RADVOR RV {name}: expected {FRAMES} forecast steps, found {found}").into());
    }
    let prefix = format!("nowcast/{issued}");
    let (batch, tiles) = encode_tiles(&frames, FRAMES, &prefix, TILE)?;
    state.count_uploads(batch.len() as u64 + 1, max_uploads)?;
    sink.put_many(&batch, "image/webp", IMMUTABLE)?;
    let index_json = json!({
        "schema": "openwetter-nowcast-1",
        "product": "DWD RADVOR RV radar nowcast, 5-minute rain amounts as mm/h (CC BY 4.0, https://opendata.dwd.de)",
        "issued": issued, "generated_at": unix_now(), "grid": grid_json(), "tile": TILE, "step_seconds": STEP,
        "first_time": issued + STEP, "frames": FRAMES, "path": format!("{prefix}/{{x}}_{{y}}.webp"), "tiles": tiles,
        "code": log_rate_describe(),
    });
    sink.put("nowcast/index.json", &serde_json::to_vec(&index_json)?, "application/json", SHORT)?;

    // The previous forecast is no longer referenced.
    if let Some(prev) = state.v["issued"].as_i64() {
        for key in tile_keys(&format!("nowcast/{prev}"), &state.v["tiles"]) {
            sink.delete(&key)?;
        }
    }
    state.v["issued"] = json!(issued);
    state.v["tiles"] = json!(index_json["tiles"]);
    state.save()?;
    let mut keep: std::collections::HashSet<String> = tile_keys(&prefix, &index_json["tiles"]).into_iter().collect();
    keep.insert("nowcast/index.json".to_owned());
    let swept = sweep(&sink, "nowcast/", &keep)?;
    if swept > 0 {
        println!("nowcast: {swept} orphaned objects swept");
    }
    println!("nowcast: issue {issued} published ({} tiles), {:.1} s; uploads this month {}", batch.len(), started.elapsed().as_secs_f64(), state.uploads());
    Ok(())
}
