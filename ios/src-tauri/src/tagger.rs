//! Automatic tagging on the iPhone, through `ios/PhotoLibrary/Tagger.swift`: Core ML runs the model
//! from the Swift library the build puts in the app's `Frameworks` folder. The core calls it through
//! the backend registered here.
use std::{
    ffi::{c_char, CStr, CString},
    path::{Path, PathBuf},
};

use gooncave_core::{
    eprintln,
    wd14_inference::{self, Inference},
};
use libloading::Library;
use objc2_foundation::NSBundle;

type Load = unsafe extern "C" fn(*const c_char, *mut c_char, usize) -> bool;
type Run = unsafe extern "C" fn(*const f32, usize, *mut f32, usize, *mut c_char, usize) -> bool;
type Unload = unsafe extern "C" fn();

const LIBRARY: &str = "Frameworks/libGoonCavePhotos.dylib";
const MESSAGE: usize = 512;

struct Native {
    // The functions below point into it, so it stays loaded for the app's lifetime.
    _library: Library,
    load: Load,
    run: Run,
    unload: Unload,
}

/// Loads the Swift library and registers the tagging backend with the core. Without it, automatic
/// tagging is unavailable.
pub fn start() {
    let path = PathBuf::from(NSBundle::mainBundle().bundlePath().to_string()).join(LIBRARY);
    // SAFETY: the library is the one this app's build embeds; it only defines these functions.
    let loaded = unsafe {
        Library::new(&path).and_then(|library| {
            Ok(Native {
                load: *library.get::<Load>(b"gooncave_tagger_load\0")?,
                run: *library.get::<Run>(b"gooncave_tagger_run\0")?,
                unload: *library.get::<Unload>(b"gooncave_tagger_unload\0")?,
                _library: library,
            })
        })
    };
    match loaded {
        Ok(native) => {
            wd14_inference::register(Box::new(native));
            eprintln!("[developer] Automatic tagging is on");
        }
        Err(error) => eprintln!("Automatic tagging is off: cannot load {path:?}: {error}"),
    }
}

/// The message Swift wrote into `buffer` for a failed call.
fn failure(buffer: &[u8]) -> String {
    CStr::from_bytes_until_nul(buffer)
        .map(|message| message.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "The tagging library gave no reason.".to_owned())
}

impl Inference for Native {
    fn load(&self, package: &Path) -> Result<(), String> {
        let package = CString::new(package.to_string_lossy().as_bytes())
            .map_err(|error| error.to_string())?;
        let mut message = [0u8; MESSAGE];
        // SAFETY: `load` is the Swift function loaded above; it reads `package` and writes at most
        // `MESSAGE` bytes into `message` before returning.
        let loaded = unsafe { (self.load)(package.as_ptr(), message.as_mut_ptr().cast(), MESSAGE) };
        if loaded {
            Ok(())
        } else {
            Err(failure(&message))
        }
    }

    fn run(&self, input: &[f32], outputs: usize) -> Result<Vec<f32>, String> {
        let mut scores = vec![0.0f32; outputs];
        let mut message = [0u8; MESSAGE];
        // SAFETY: as for `load`; Swift reads `input.len()` floats and writes `outputs` floats.
        let ran = unsafe {
            (self.run)(
                input.as_ptr(),
                input.len(),
                scores.as_mut_ptr(),
                outputs,
                message.as_mut_ptr().cast(),
                MESSAGE,
            )
        };
        if ran {
            Ok(scores)
        } else {
            Err(failure(&message))
        }
    }

    fn unload(&self) {
        // SAFETY: `unload` is the Swift function loaded above; it takes and answers nothing.
        unsafe { (self.unload)() };
    }
}
