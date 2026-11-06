//! Official DWD weather warnings (CAP, district level, German + English) as one compact JSON.
//!
//! Source: opendata.dwd.de/weather/alerts/cap/DISTRICT_DWD_STAT/ — the LATEST zip holds one
//! CAP XML file per active warning, with district polygons. German and English files share
//! the same identifier stem. Uploaded only when the content changes.

use std::{collections::BTreeMap, io::Read, path::PathBuf};

use serde_json::{Value, json};

use crate::common::*;

const URL: &str = "https://opendata.dwd.de/weather/alerts/cap/DISTRICT_DWD_STAT/Z_CAP_C_EDZW_LATEST_PVW_STATUS_PREMIUMDWD_DISTRICT_";

/// Text of the first `<tag>...</tag>` inside `s`, XML-unescaped.
fn tag(s: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = s.find(&open)? + open.len();
    let end = start + s[start..].find(&close)?;
    Some(unescape(&s[start..end]))
}

/// All `<tag>...</tag>` blocks (raw).
fn blocks<'a>(s: &'a str, name: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{name}>"), format!("</{name}>"));
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(&close) else { break };
        out.push(&after[..j]);
        rest = &after[j + close.len()..];
    }
    out
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(j) = tail.find(';') else {
            out.push_str(tail);
            return out;
        };
        let entity = &tail[1..j];
        match entity {
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "amp" => out.push('&'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            _ => {
                let code = entity
                    .strip_prefix("#x")
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()));
                match code.and_then(char::from_u32) {
                    Some(c) => out.push(c),
                    None => out.push_str(&tail[..=j]),
                }
            }
        }
        rest = &tail[j + 1..];
    }
    out.push_str(rest);
    out
}

/// "lat,lon lat,lon ..." -> [[lon, lat], ...] rounded to ~100 m.
fn polygon(s: &str) -> Value {
    let r = |v: f64| (v * 1000.0).round() / 1000.0;
    let pts: Vec<Value> = s
        .split_whitespace()
        .filter_map(|p| {
            let (la, lo) = p.split_once(',')?;
            Some(json!([r(lo.parse().ok()?), r(la.parse().ok()?)]))
        })
        .collect();
    json!(pts)
}

struct Parsed {
    msg_type: String,
    info: BTreeMap<String, Value>,
    areas: Vec<Value>,
}

fn parse(xml: &str) -> Option<Parsed> {
    let info_xml = blocks(xml, "info").into_iter().next()?;
    let mut info = BTreeMap::new();
    for key in ["event", "urgency", "severity", "certainty", "headline", "description", "instruction"] {
        if let Some(v) = tag(info_xml, key) {
            info.insert(key.to_owned(), json!(v.trim()));
        }
    }
    for key in ["onset", "expires", "effective"] {
        if let Some(t) = tag(info_xml, key).and_then(|v| parse_iso(&v)) {
            info.insert(key.to_owned(), json!(t));
        }
    }
    for code in blocks(info_xml, "eventCode") {
        match (tag(code, "valueName").as_deref(), tag(code, "value")) {
            (Some("II"), Some(v)) => {
                info.insert("event_code".into(), json!(v));
            }
            (Some("GROUP"), Some(v)) => {
                info.insert("group".into(), json!(v));
            }
            (Some("AREA_COLOR"), Some(v)) => {
                let rgb: Vec<u8> = v.split_whitespace().filter_map(|x| x.parse().ok()).collect();
                info.insert("color".into(), json!(rgb));
            }
            _ => {}
        }
    }
    let areas = blocks(info_xml, "area")
        .into_iter()
        .map(|a| {
            let polys: Vec<Value> = blocks(a, "polygon").into_iter().map(polygon).collect();
            json!({"name": tag(a, "areaDesc").unwrap_or_default(), "polygons": polys})
        })
        .collect();
    Some(Parsed { msg_type: tag(xml, "msgType").unwrap_or_default(), info, areas })
}

/// identifier stem -> parsed warning, for one language zip.
fn read_zip(agent: &ureq::Agent, lang: &str) -> Res<BTreeMap<String, Parsed>> {
    let bytes = get(agent, &format!("{URL}{lang}.zip"))?;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut out = BTreeMap::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        let name = String::from_utf8_lossy(f.name_raw()).into_owned();
        let Some(stem) = name.strip_suffix(".DEU.xml").or_else(|| name.strip_suffix(".ENG.xml")).map(str::to_owned) else { continue };
        let mut xml = String::new();
        f.read_to_string(&mut xml)?;
        if let Some(p) = parse(&xml) {
            out.insert(stem, p);
        }
    }
    Ok(out)
}

pub fn run(args: &[String]) -> Res<()> {
    let max_uploads: u64 = arg(args, "--max-uploads-month").map(|v| v.parse()).transpose()?.unwrap_or(50_000);
    let state_path = PathBuf::from(arg(args, "--state").unwrap_or_else(|| "openwetter-warnings-state.json".into()));
    let sink = Sink::from_args(flag(args, "--publish"), arg(args, "--out"))?;
    let agent = agent();
    let mut state = State::load(&state_path, json!({"digest": null, "month": "", "uploads": 0}))?;

    let de = read_zip(&agent, "DE")?;
    let en = read_zip(&agent, "EN")?;
    let now = unix_now();
    let mut warnings = Vec::new();
    for (id, w) in &de {
        if w.msg_type == "Cancel" || w.info.get("expires").and_then(Value::as_i64).is_some_and(|e| e < now) {
            continue;
        }
        let e = en.get(id);
        let text = |k: &str| json!({"de": w.info.get(k).cloned().unwrap_or(Value::Null),
                                     "en": e.and_then(|e| e.info.get(k).cloned()).unwrap_or(Value::Null)});
        let field = |k: &str| w.info.get(k).cloned().unwrap_or(Value::Null);
        warnings.push(json!({
            "id": id, "event": field("event"), "event_en": e.and_then(|e| e.info.get("event").cloned()).unwrap_or(Value::Null),
            "event_code": field("event_code"), "group": field("group"),
            "severity": field("severity"), "urgency": field("urgency"), "certainty": field("certainty"),
            "onset": field("onset"), "expires": field("expires"), "effective": field("effective"), "color": field("color"),
            "headline": text("headline"), "description": text("description"), "instruction": text("instruction"),
            "areas": w.areas,
        }));
    }
    warnings.sort_by_key(|w| (w["onset"].as_i64(), w["id"].as_str().map(str::to_owned)));
    let body = json!({"warnings": warnings});
    let digest = format!("{:016x}", fnv(&serde_json::to_vec(&body)?));
    if state.v["digest"] == digest.as_str() {
        println!("warnings: {} active, unchanged", body["warnings"].as_array().map_or(0, Vec::len));
        return Ok(());
    }
    let out = json!({
        "schema": "openwetter-warnings-1",
        "source": "DWD CAP warnings, district level (CC BY 4.0, https://opendata.dwd.de); polygons © GeoBasis-DE / BKG",
        "generated_at": now, "warnings": body["warnings"],
    });
    state.count_uploads(1, max_uploads)?;
    sink.put("warnings/index.json", &serde_json::to_vec(&out)?, "application/json", SHORT)?;
    state.v["digest"] = json!(digest);
    state.save()?;
    println!("warnings: {} active, published; uploads this month {}", out["warnings"].as_array().map_or(0, Vec::len), state.uploads());
    Ok(())
}

/// FNV-1a 64-bit digest to detect changed content.
fn fnv(b: &[u8]) -> u64 {
    b.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &x| (h ^ x as u64).wrapping_mul(0x0100_0000_01b3))
}
