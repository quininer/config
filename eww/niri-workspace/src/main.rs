#!/usr/bin/env cargo
//! ```cargo
//! [dependencies]
//! anyhow = "1"
//! serde = "1"
//! serde_json = "1"
//! ```

use std::io::{ self, Write };
use std::collections::BTreeMap;
use serde::ser::SerializeSeq;
use serde::Serialize;
use indexmap::IndexMap;
use niri_ipc::state::{ EventStreamState, EventStreamStatePart };
use niri_ipc::{ Request, Response };

#[derive(Serialize, Default)]
pub(crate) struct WorkspaceState<'a> {
    outputs: BTreeMap<&'a str, Output>,
}

#[derive(Serialize, Default)]
struct Output {
    #[serde(serialize_with = "as_array")]
    workspaces: IndexMap<u64, Workspace>,
}

#[derive(Serialize, Default)]
struct Workspace {
    id: u64,
    index: u8,
    is_active: bool,
    windows: Vec<Window>,
}

#[derive(Serialize, Default)]
struct Window {
    id: u64,
    pos: usize,
    is_focused: bool,
}

fn main() -> anyhow::Result<()> {
    let stdout = io::stdout();
    let mut socket = niri_ipc::socket::Socket::connect()?;

    let resp = socket.send(Request::EventStream)?
        .map_err(|err| anyhow::Error::msg(err))?;
    if !matches!(resp, Response::Handled) {
        anyhow::bail!("bad response: {:?}", resp);
    }

    let mut next = socket.read_events();
    let mut state = EventStreamState::default();
    loop {
        let event = next()?;
        if state.apply(event).is_none() {
            let mut state2 = WorkspaceState::default();
            for workspace in state.workspaces.workspaces.values() {
                let name = workspace.output.as_deref().unwrap_or_default();
                let ws = state2.outputs
                    .entry(name)
                    .or_default()
                    .workspaces
                    .entry(workspace.id)
                    .or_default();
                ws.id = workspace.id;
                ws.index = workspace.idx;
                ws.is_active = workspace.is_active;
            }
            for window in state.windows.windows.values() {
                let Some(ws_id) = window.workspace_id
                    else { continue };

                if let Some(workspace) = state2.outputs
                    .values_mut()
                    .find_map(|workspace| workspace.workspaces.get_mut(&ws_id))
                {
                    workspace.windows.push(Window {
                        id: ws_id,
                        pos: window.layout.pos_in_scrolling_layout.unwrap_or_default().0,
                        is_focused: window.is_focused
                    });
                }
            }

            state2.outputs.values_mut()
                .for_each(|output| output.workspaces.sort_by(|_, v0, _, v1| v0.index.cmp(&v1.index)));

            state2.outputs.values_mut()
                .flat_map(|output| output.workspaces.values_mut())
                .for_each(|workspace| {
                    workspace.windows.sort_by(|v0, v1|
                        (v0.pos, v0.id).cmp(&(v1.pos, v1.id))
                    );
                });

            let mut stdout = stdout.lock();
            serde_json::to_writer(&mut stdout, &state2)?;
            stdout.write_all(b"\n")?;
        }
    }
}

fn as_array<S>(value: &IndexMap<u64, Workspace>, s: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer
{
    let mut s = s.serialize_seq(Some(value.len()))?;
    for ws in value.values() {
        s.serialize_element(ws)?;
    }
    s.end()
}
