//! Where the iPhone runs the WD14 model, which only the shell can reach (Core ML). A shell
//! registers its backend here; the core prepares the picture and picks the tags from the scores.
use std::{path::Path, sync::OnceLock};

pub trait Inference: Send + Sync {
    /// Loads the Core ML package at `package`. Called before `run`; loading again replaces the model.
    fn load(&self, package: &Path) -> Result<(), String>;
    /// Runs the loaded model on `input`, a 448x448 BGR picture of floats 0 to 255 in NHWC order,
    /// and returns the `outputs` scores of 0 to 1.
    fn run(&self, input: &[f32], outputs: usize) -> Result<Vec<f32>, String>;
    /// Frees the loaded model.
    fn unload(&self);
}

static BACKEND: OnceLock<Box<dyn Inference>> = OnceLock::new();

/// Registers the backend once at startup; later calls are ignored.
pub fn register(backend: Box<dyn Inference>) {
    let _ = BACKEND.set(backend);
}

#[cfg(target_os = "ios")]
pub(crate) fn get() -> Option<&'static dyn Inference> {
    BACKEND.get().map(|backend| backend.as_ref())
}
