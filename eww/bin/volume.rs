use std::mem;
use std::time::{ Instant, Duration };
use std::io::{ self, Write, Read, BufRead };
use std::process::{Command, Stdio };
use anyhow::Context;
use serde::Serialize;

#[derive(Serialize)]
struct Output {
    value: usize,
    muted: bool
}

const LIMIT: Duration = Duration::from_millis(500);

fn main() -> anyhow::Result<()> {
    let mut monitor = Command::new("pw-cli")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .args(["info", "all"])
        .arg("--monitor")
        .spawn()?;

    let reader = monitor
        .stdout
        .as_mut()
        .context("need monitor stdout")?;
    let mut reader = io::BufReader::new(reader);
    let mut line = String::new();
    let stdout = std::io::stdout();

    let push = |line: &mut String| {
        let output = get_volume(line)?;
        let mut stdout = stdout.lock();
        serde_json::to_writer(&mut stdout, &output)?;
        stdout.write_all(b"\n")?;
        Ok(()) as anyhow::Result<()>
    };

    push(&mut line)?;

    // skip
    let mut now = Instant::now();
    loop {
        line.clear();
        reader.read_line(&mut line)?;

        let prev = mem::replace(&mut now, Instant::now());
        if now - prev > LIMIT {
            break
        }
    }

    if let Err(err) = push(&mut line) {
        eprintln!("{}", err);
    }

    loop {
        line.clear();
        reader.read_line(&mut line)?;

        if !line.trim_start().starts_with("id: ") {
            continue
        }

        if let Err(err) = push(&mut line) {
            eprintln!("{}", err);
        }
    }
}

fn get_volume(line: &mut String) -> anyhow::Result<Output> {
    let mut child = std::process::Command::new("wpctl")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .arg("get-volume")
        .arg("@DEFAULT_AUDIO_SINK@")
        .spawn()?;
    let stdout = child.stdout.as_mut()
        .context("need volume stdout")?;
    line.clear();
    stdout.read_to_string(line)?;
    child.kill()?;
    let status = child.wait()?;

    if !status.success() {
        anyhow::bail!("get volume failed: {:?}", status);
    }

    let line = line.strip_prefix("Volume: ").context("bad format")?;
    let (value, state) = line.split_once(' ').unwrap_or((line, ""));
    let value: f64 = value.trim_end().parse()?;

    let value = (value * 100.) as usize;
    let muted = value == 0 || state.trim() == "[MUTED]";

    Ok(Output { value, muted })
}
