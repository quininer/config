use std::time::Duration;
use std::{ mem, thread };
use std::io::{ self, Write };
use anyhow::Context;
use serde::Serialize;
use starship_battery::State;

#[derive(Serialize, Eq, PartialEq, Default)]
struct Battery {
    power: usize,
    charging: bool
}

fn main() -> anyhow::Result<()> {
    let manager = starship_battery::Manager::new()?;
    let stdout = io::stdout();

    let mut now = Battery::default();
    let mut battery = manager.batteries()?.next().context("not found battery")??;

    loop {
        let power = (battery.state_of_charge().value * 100.) as usize;
        let charging = match battery.state() {
            State::Charging => true,
            State::Discharging => false,
            State::Unknown => power >= 100,
            _ => false
        };

        let prev = mem::replace(&mut now, Battery { power, charging });
        if prev != now {
            let mut stdout = stdout.lock();
            serde_json::to_writer(&mut stdout, &now)?;
            stdout.write_all(b"\n")?;
        }

        thread::sleep(Duration::from_secs(10));
        manager.refresh(&mut battery)?;
    }
}
