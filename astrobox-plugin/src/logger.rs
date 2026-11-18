// Logging for a WASI plugin.
//
// No file appender here: tracing-appender's rolling writer calls
// `symlink::symlink_file`, which is compiled out on wasm targets and fails to
// build. AstroBox already captures the plugin's stdout, so stdout is enough.

use std::io::{self, Write};

use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt};

pub fn init() {
    let console_layer = fmt::layer()
        .with_target(true)
        .with_ansi(false)
        .with_writer(|| PluginWriter(io::stdout()))
        .compact();

    // try_init: a second load of the same plugin must not panic on an
    // already-installed global subscriber.
    let _ = tracing_subscriber::registry()
        .with(console_layer)
        .try_init();
}

struct PluginWriter<W: Write>(W);

impl<W: Write> Write for PluginWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write_all(b"[Plugin] ")?;
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}
