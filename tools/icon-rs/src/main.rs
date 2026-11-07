//! OpenWetter publisher: DWD open data -> compact 8-bit WebP tiles and JSON on Cloudflare R2.
//!
//! Subcommands (each takes `--out DIR` for a local dry run or `--publish` for R2, plus `--state FILE`):
//!   icon      ICON map layers and chart series: --model icon_d2 (default; plus 5-day history),
//!             icon_eu or icon_global (cropped to Germany and neighbours)
//!   radar     observed RADOLAN RY radar, last two days (every 5 minutes)
//!   nowcast   RADVOR RV 2-hour radar nowcast (every 5 minutes)
//!   warnings  official DWD CAP warnings (every 5 minutes)
//!
//! Environment for `--publish`: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.

mod common;
mod icon;
mod radar;
mod warnings;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = match args.get(1).map(String::as_str) {
        Some("icon") => icon::run(&args[2..]),
        Some("radar") => radar::run_radar(&args[2..]),
        Some("nowcast") => radar::run_nowcast(&args[2..]),
        Some("warnings") => warnings::run(&args[2..]),
        Some("--version" | "version") => {
            // OPENWETTER_COMMIT is set by the GitHub build; local builds say "local".
            println!("icon-rs {} ({})", env!("CARGO_PKG_VERSION"), option_env!("OPENWETTER_COMMIT").unwrap_or("local"));
            Ok(())
        }
        // Backwards compatible: plain flags mean the ICON publisher.
        Some(a) if a.starts_with("--") => icon::run(&args[1..]),
        _ => Err("usage: icon-rs (icon|radar|nowcast|warnings) (--out DIR | --publish) [--state FILE] | icon-rs --version".into()),
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
