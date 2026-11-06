//! Shared helpers: HTTP, 8-bit codes, WebP tiles, R2/local output, state files, time.

use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use serde_json::{Value, json};

pub type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub const NODATA: u8 = 255;
pub const MIN_RATE: f32 = 0.05; // mm/h, below = dry
pub const MAX_RATE: f32 = 64.0; // mm/h
pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";
pub const SHORT: &str = "public, max-age=60";
const USER_AGENT: &str = "OpenWetter-publisher/0.3 (noncommercial open-source weather viewer)";
const UPLOAD_THREADS: usize = 4;

pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(Duration::from_secs(120)))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

/// GET with up to three attempts; DWD occasionally drops connections.
pub fn get(agent: &ureq::Agent, url: &str) -> Res<Vec<u8>> {
    let mut last = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(5 * attempt));
        }
        match agent.get(url).call() {
            Ok(mut res) if res.status() == 200 => {
                return Ok(res.body_mut().with_config().limit(64 * 1024 * 1024).read_to_vec()?);
            }
            Ok(res) => last = format!("HTTP {}", res.status()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("{url}: {last}").into())
}

/// Links in an Apache-style directory listing.
pub fn listing(agent: &ureq::Agent, url: &str) -> Res<Vec<String>> {
    let html = String::from_utf8(get(agent, url)?)?;
    Ok(html
        .split("href=\"")
        .skip(1)
        .filter_map(|s| s.split('"').next())
        .map(|h| h.replace("%3A", ":"))
        .collect())
}

/// 8-bit log rain-rate code shared by model rain, radar and nowcast.
pub fn log_rate_code(rate: f32) -> u8 {
    if !rate.is_finite() {
        return NODATA;
    }
    if rate < MIN_RATE {
        return 0;
    }
    // libm gives bit-identical results on every platform (system ln does not).
    let x = libm::logf(rate / MIN_RATE) / libm::logf(MAX_RATE / MIN_RATE);
    (1.0 + (253.0 * x).round()).clamp(1.0, 254.0) as u8
}

pub fn log_rate_describe() -> Value {
    json!({"unit": "mm/h", "dry": 0,
        "decode": format!("value = {MIN_RATE} * ({MAX_RATE}/{MIN_RATE})^((code-1)/253) for code 1..=254; 0 = below {MIN_RATE}")})
}

pub fn encode_lossless(rgb: &[u8], w: u32, h: u32) -> Res<Vec<u8>> {
    let mut config = webp::WebPConfig::new().map_err(|_| "WebP config")?;
    config.lossless = 1;
    config.method = 4; // ~4% larger than method 6 but ~40x faster
    config.quality = 75.0;
    config.exact = 1;
    let mem = webp::Encoder::from_rgb(rgb, w, h)
        .encode_advanced(&config)
        .map_err(|e| format!("WebP encode: {e:?}"))?;
    Ok(mem.to_vec())
}

/// Copy one tile of `nframes` stacked frames (each `width` x `height`, row 0 north) into a grey
/// RGB image. Returns (w, h, has_data, has_nonzero).
#[allow(clippy::too_many_arguments)]
pub fn tile_rgb(
    frames: &[u8],
    nframes: usize,
    width: usize,
    height: usize,
    tile: usize,
    tx: usize,
    ty: usize,
    rgb: &mut Vec<u8>,
) -> (usize, usize, bool, bool) {
    let plane = width * height;
    let (w, h) = (tile.min(width - tx * tile), tile.min(height - ty * tile));
    rgb.resize(w * h * nframes * 3, 0);
    let (mut data, mut nonzero) = (false, false);
    for f in 0..nframes {
        for r in 0..h {
            let src = f * plane + (ty * tile + r) * width + tx * tile;
            for c in 0..w {
                let v = frames[src + c];
                data |= v != NODATA;
                nonzero |= v != NODATA && v != 0;
                let o = ((f * h + r) * w + c) * 3;
                rgb[o..o + 3].fill(v);
            }
        }
    }
    (w, h, data, nonzero)
}

/// Where objects go: a local directory or the R2 bucket (S3 API, signed requests).
pub enum Sink {
    Local(PathBuf),
    R2 { agent: ureq::Agent, bucket: Box<Bucket>, creds: Credentials },
}

impl Sink {
    pub fn from_args(publish: bool, out: Option<String>) -> Res<Sink> {
        if publish {
            let var = |k: &str| env::var(k).map_err(|_| format!("missing environment variable {k}"));
            let bucket = Bucket::new(var("R2_ENDPOINT")?.parse()?, UrlStyle::Path, var("R2_BUCKET")?, "auto")?;
            let creds = Credentials::new(var("R2_ACCESS_KEY_ID")?, var("R2_SECRET_ACCESS_KEY")?);
            Ok(Sink::R2 { agent: agent(), bucket: Box::new(bucket), creds })
        } else if let Some(dir) = out {
            Ok(Sink::Local(PathBuf::from(dir)))
        } else {
            Err("choose --out DIR or --publish".into())
        }
    }

    /// Upload a batch with a few parallel connections.
    pub fn put_many(&self, batch: &[(String, Vec<u8>)], content_type: &str, cache: &str) -> Res<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let per = batch.len().div_ceil(UPLOAD_THREADS);
        std::thread::scope(|scope| {
            let handles: Vec<_> = batch
                .chunks(per)
                .map(|part| scope.spawn(move || part.iter().try_for_each(|(k, b)| self.put(k, b, content_type, cache))))
                .collect();
            handles.into_iter().try_for_each(|h| h.join().map_err(|_| "upload thread panicked")?)
        })
    }

    pub fn put(&self, key: &str, body: &[u8], content_type: &str, cache: &str) -> Res<()> {
        match self {
            Sink::Local(dir) => {
                let path = dir.join(key);
                fs::create_dir_all(path.parent().ok_or("bad key")?)?;
                fs::write(path, body)?;
                Ok(())
            }
            Sink::R2 { agent, bucket, creds } => {
                let mut action = bucket.put_object(Some(creds), key);
                action.headers_mut().insert("content-type", content_type.to_owned());
                action.headers_mut().insert("cache-control", cache.to_owned());
                let url = action.sign(Duration::from_secs(900));
                let mut last = String::new();
                for attempt in 0..3 {
                    if attempt > 0 {
                        std::thread::sleep(Duration::from_secs(3 * attempt));
                    }
                    let res = agent
                        .put(url.as_str())
                        .header("content-type", content_type)
                        .header("cache-control", cache)
                        .send(body);
                    match res {
                        Ok(r) if r.status().is_success() => return Ok(()),
                        Ok(mut r) => last = format!("HTTP {}: {}", r.status(), r.body_mut().read_to_string().unwrap_or_default()),
                        Err(e) => last = e.to_string(),
                    }
                }
                Err(format!("upload {key}: {last}").into())
            }
        }
    }

    /// Every object key under `prefix` (paginated S3 ListObjectsV2 on R2, a directory walk locally).
    pub fn list(&self, prefix: &str) -> Res<Vec<String>> {
        match self {
            Sink::Local(dir) => {
                let mut out = Vec::new();
                let mut stack = vec![dir.join(prefix)];
                while let Some(d) = stack.pop() {
                    let Ok(entries) = fs::read_dir(&d) else { continue };
                    for e in entries.flatten() {
                        let p = e.path();
                        if p.is_dir() {
                            stack.push(p);
                        } else if let Ok(rel) = p.strip_prefix(dir) {
                            out.push(rel.to_string_lossy().into_owned());
                        }
                    }
                }
                Ok(out)
            }
            Sink::R2 { agent, bucket, creds } => {
                let mut out = Vec::new();
                let mut token: Option<String> = None;
                loop {
                    let mut action = bucket.list_objects_v2(Some(creds));
                    action.with_prefix(prefix);
                    if let Some(t) = &token {
                        action.with_continuation_token(t.clone());
                    }
                    let url = action.sign(Duration::from_secs(600));
                    let mut res = agent.get(url.as_str()).call()?;
                    if !res.status().is_success() {
                        return Err(format!("list {prefix}: HTTP {}", res.status()).into());
                    }
                    let body = res.body_mut().with_config().limit(32 * 1024 * 1024).read_to_string()?;
                    let parsed = rusty_s3::actions::ListObjectsV2::parse_response(&body).map_err(|e| format!("list {prefix}: {e}"))?;
                    out.extend(parsed.contents.into_iter().map(|c| c.key));
                    match parsed.next_continuation_token {
                        Some(t) => token = Some(t),
                        None => return Ok(out),
                    }
                }
            }
        }
    }

    /// Delete objects (free on R2); missing objects are fine.
    pub fn delete(&self, key: &str) -> Res<()> {
        match self {
            Sink::Local(dir) => {
                let _ = fs::remove_file(dir.join(key));
                Ok(())
            }
            Sink::R2 { agent, bucket, creds } => {
                let url = bucket.delete_object(Some(creds), key).sign(Duration::from_secs(600));
                let res = agent.delete(url.as_str()).call()?;
                if res.status().is_success() || res.status() == 404 {
                    Ok(())
                } else {
                    Err(format!("delete {key}: HTTP {}", res.status()).into())
                }
            }
        }
    }
}

/// JSON state file with a monthly upload counter that refuses to exceed a budget.
pub struct State {
    pub v: Value,
    path: PathBuf,
}

impl State {
    pub fn load(path: &Path, empty: Value) -> Res<State> {
        let v = match fs::read(path) {
            Ok(b) => serde_json::from_slice(&b)?,
            Err(_) => empty,
        };
        Ok(State { v, path: path.to_owned() })
    }
    pub fn save(&self) -> Res<()> {
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec(&self.v)?)?;
        fs::rename(tmp, &self.path)?;
        Ok(())
    }
    pub fn uploads(&self) -> u64 {
        self.v["uploads"].as_u64().unwrap_or(0)
    }
    /// Count R2 writes; refuse once the monthly budget would be exceeded.
    pub fn count_uploads(&mut self, n: u64, max: u64) -> Res<()> {
        let month = civil_month(unix_now() / 86_400);
        if self.v["month"] != month.as_str() {
            self.v["month"] = json!(month);
            self.v["uploads"] = json!(0);
        }
        let total = self.uploads() + n;
        if total > max {
            return Err(format!("monthly upload budget of {max} reached; stopping to stay in the R2 free tier").into());
        }
        self.v["uploads"] = json!(total);
        // Persist at once so a crash cannot make the budget forget uploads already made.
        self.save()
    }
}

/// Delete every object under `prefix` that is not in `keep`. Returns the number deleted.
pub fn sweep(sink: &Sink, prefix: &str, keep: &std::collections::HashSet<String>) -> Res<usize> {
    let mut n = 0;
    for key in sink.list(prefix)? {
        if !keep.contains(&key) {
            sink.delete(&key)?;
            n += 1;
        }
    }
    Ok(n)
}

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// Days since 1970-01-01 for a civil (proleptic Gregorian) date.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "YYYY-MM" for a day count since 1970-01-01 (UTC).
pub fn civil_month(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}")
}

/// Parse "YYYY-MM-DDTHH:MM:SS(+HH:MM|Z)" to unix seconds.
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.trim();
    let num = |a: usize, n: usize| b.get(a..a + n)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let tz = &b[19..];
    let offset = if tz.is_empty() || tz == "Z" {
        0
    } else {
        let sign = if tz.starts_with('-') { -1 } else { 1 };
        sign * (tz.get(1..3)?.parse::<i64>().ok()? * 3600 + tz.get(4..6)?.parse::<i64>().ok()? * 60)
    };
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset)
}

/// Value of `--name` in the argument list.
pub fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

pub fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}
