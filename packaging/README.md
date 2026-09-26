# PC installer

PC 1.0.0 ships a Linux installer compiled from the Go source in `installer/`.
It contains a Compose file for the existing API, worker, and tagger images.
It does not contain Docker or the images themselves. Windows packaging is
deferred to PC 1.3.0.

## Build

From the repository root, after both images for a commit have been published to
GHCR:

```sh
bash packaging/build.sh <40-character-commit-sha>
```

The build writes a Linux x86-64 binary plus `SHA256SUMS` to
`dist/pc-installer/`. Attach those files to the approved `pc/v<version>` GitHub
Release only after testing the exact images and binary. The CI job compiles
the Linux binary and runs the Go tests, but does not publish a release.

## Install on a PC

Install and start Docker Engine with the Compose plugin. Download the Linux
binary from the release assets and grant it execute permission. Double-clicking
it opens a terminal window and shows Docker's progress. Keep that window open
until the installer finishes. If no supported terminal is available, run the
binary from a terminal yourself. Do not run it with `sudo`.

The first run creates a GoonCave folder in the current user's config directory,
copies the executable to a stable location, adds **GoonCave** and **Uninstall
GoonCave** to the application menu, and starts the app at
<http://localhost:4100>. The downloaded file may then be deleted. Use the menu
entry to start GoonCave again. `stop` stops the containers but keeps the data.
The installer saves the active Docker context in `docker-context` and uses it
for every later start, stop, and uninstall. On Linux, this keeps Docker Engine
(`default`) and Docker Desktop (`desktop-linux`) installations separate even if
you change your active context. Keep Docker running in the saved context.
If an older installation has no `docker-context` file, run `docker context ls`,
select the context that contains its GoonCave containers, set `DOCKER_CONTEXT`
to that name, and rerun the installer. It will not guess from the active context.
If you use `DOCKER_HOST`, select an explicit Docker context before installing;
the installer cannot safely save an endpoint supplied only through that variable.
The installed executable and data are usually in `~/.config/GoonCave`,
alongside an **Uninstall GoonCave** link.

The SQLite database and uploaded media live in `data/storage` and
`data/library` under that directory. Back up the entire `data` directory while
GoonCave is stopped. The tagger model lives in a separate Docker volume and can
be downloaded again. The first startup may take several minutes while the model
downloads. The app is bound to localhost, so other devices cannot reach it.

The **Uninstall GoonCave** link asks for confirmation, then asks whether to keep
the database and media library. Keeping data is the default. In both cases,
the installer removes GoonCave containers and their Docker images. If data is
kept, the Compose configuration and tagger model volume are also retained. If
data removal is selected, the installer removes the local database, media
library, configuration, and tagger model volume. It then removes the saved
context, menu entries, and installed executable. Reinstalling the same version
can reuse retained data but must download the images again. To install a newer
version, back up `data`, uninstall the old version while keeping data, and run
the newer installer. It keeps the saved Docker context and data, and saves the
old Compose file as `compose.yaml.previous`. Running a newer installer before
uninstalling the old one stops without changing the version or user data. The
installer does not install Docker.

There is no separate uninstaller download. The installed folder contains an
uninstall link. If it is not visible, run the installed executable with
`uninstall` from a terminal. The default command is
`~/.config/GoonCave/gooncave uninstall`.
