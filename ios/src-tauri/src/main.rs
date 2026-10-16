// The iPhone app starts from `run` in lib.rs; this binary lets `cargo check` build it on a desktop.
fn main() {
    gooncave_ios_lib::run()
}
