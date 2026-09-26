package main

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInstallCreatesPinnedConfigurationAndPreservesIt(t *testing.T) {
	appImage, taggerImage = "ghcr.io/liukscot/gooncave:abc123", "ghcr.io/liukscot/gooncave-tagger:abc123"
	t.Cleanup(func() { appImage, taggerImage = "", "" })
	dir := t.TempDir()
	if err := install(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "compose.yaml")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"ghcr.io/liukscot/gooncave:abc123", "ghcr.io/liukscot/gooncave-tagger:abc123", "127.0.0.1:4100:4100", "./data/storage:/app/storage", "./data/library:/gooncave-library"} {
		if !strings.Contains(string(content), want) {
			t.Errorf("configuration missing %q", want)
		}
	}
	for _, name := range []string{"storage", "library"} {
		if info, err := os.Stat(filepath.Join(dir, "data", name)); err != nil || !info.IsDir() {
			t.Errorf("directory %s missing: %v", name, err)
		}
	}
	if os.PathSeparator == '/' {
		for _, path := range []string{dir, filepath.Join(dir, "data"), filepath.Join(dir, "data", "storage"), filepath.Join(dir, "data", "library")} {
			if err := os.Chmod(path, 0755); err != nil {
				t.Fatal(err)
			}
		}
		if err := install(dir); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{dir, filepath.Join(dir, "data"), filepath.Join(dir, "data", "storage"), filepath.Join(dir, "data", "library")} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0700 {
				t.Fatalf("directory %s is not private: %v, %v", path, info, err)
			}
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "data", "storage", "keep.txt"), []byte("user data"), 0600); err != nil {
		t.Fatal(err)
	}
	appImage = "ghcr.io/liukscot/gooncave:different"
	if err := install(dir); err == nil {
		t.Fatal("a new version overwrote the installation without an explicit upgrade")
	}
	again, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != string(content) {
		t.Fatal("a second installation overwrote the configuration")
	}
	data, err := os.ReadFile(filepath.Join(dir, "data", "storage", "keep.txt"))
	if err != nil || string(data) != "user data" {
		t.Fatalf("data was not preserved: %q, %v", data, err)
	}
}

func TestGeneratedComposeIsValid(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("Docker unavailable")
	}
	appImage, taggerImage = "ghcr.io/liukscot/gooncave:abc123", "ghcr.io/liukscot/gooncave-tagger:abc123"
	t.Cleanup(func() { appImage, taggerImage = "", "" })
	dir := t.TempDir()
	if err := install(dir); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("docker", "compose", "-f", filepath.Join(dir, "compose.yaml"), "config", "-q")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("invalid Compose configuration: %s: %v", output, err)
	}
}

func TestInstallRejectsUnversionedBinary(t *testing.T) {
	appImage, taggerImage = "", ""
	if err := install(t.TempDir()); err == nil {
		t.Fatal("installer without images was accepted")
	}
}

func TestDesktopErrorIsVisible(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("Linux desktop test")
	}
	dir := t.TempDir()
	dialogOutput := filepath.Join(dir, "dialog.txt")
	zenity := filepath.Join(dir, "zenity")
	if err := os.WriteFile(zenity, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$GOONCAVE_DIALOG_TEST\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("GOONCAVE_DIALOG_TEST", dialogOutput)
	if !desktopLaunch(":1", "", false) {
		t.Fatal("desktop launch was not recognized")
	}
	if desktopLaunch(":1", "", true) {
		t.Fatal("opened a second terminal inside an existing one")
	}
	showDesktopMessage("Docker unavailable", true)
	content, err := os.ReadFile(dialogOutput)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "--error") || !strings.Contains(string(content), "Docker unavailable") {
		t.Fatalf("incorrect desktop message: %s", content)
	}
}

func TestDesktopLaunchStartsTerminalWithInstaller(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("Linux desktop test")
	}
	dir := t.TempDir()
	outputPath := filepath.Join(dir, "terminal.txt")
	terminal := filepath.Join(dir, "ptyxis")
	if err := os.WriteFile(terminal, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$GOONCAVE_TERMINAL_TEST\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("GOONCAVE_TERMINAL_TEST", outputPath)
	if err := launchTerminal([]string{"start"}); err != nil {
		t.Fatal(err)
	}
	var content []byte
	var err error
	for attempt := 0; attempt < 50; attempt++ {
		content, err = os.ReadFile(outputPath)
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--new-window", "--terminal", "start"} {
		if !strings.Contains(string(content), want) {
			t.Fatalf("terminal launched without %q: %s", want, content)
		}
	}
}

func TestDockerPermissionErrorExplainsCause(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("Linux Docker test")
	}
	dir := t.TempDir()
	docker := filepath.Join(dir, "docker")
	if err := os.WriteFile(docker, []byte("#!/bin/sh\necho 'permission denied while trying to connect to the docker API' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	err := checkDocker("default")
	if err == nil || !strings.Contains(err.Error(), "your user cannot access Docker") {
		t.Fatalf("permission error was not explained: %v", err)
	}
}

func TestDockerHostOverrideRequiresExplicitContext(t *testing.T) {
	t.Setenv("DOCKER_HOST", "tcp://localhost:2375")
	t.Setenv("DOCKER_CONTEXT", "")
	if _, err := dockerContext(t.TempDir()); err == nil || !strings.Contains(err.Error(), "DOCKER_HOST") {
		t.Fatalf("Docker host override was accepted without a context: %v", err)
	}
}

func TestLegacyInstallationRequiresExplicitDockerContext(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "compose.yaml"), []byte("name: gooncave-pc\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DOCKER_CONTEXT", "")
	if _, err := dockerContext(dir); err == nil || !strings.Contains(err.Error(), "no saved Docker context") {
		t.Fatalf("legacy installation silently used the active context: %v", err)
	}
	t.Setenv("DOCKER_CONTEXT", "desktop-linux")
	if got, err := dockerContext(dir); err != nil || got != "desktop-linux" {
		t.Fatalf("explicit legacy context was not used: %q, %v", got, err)
	}
}

func TestLauncherFailureDoesNotStartContainers(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("Linux desktop test")
	}
	base := t.TempDir()
	binDir := filepath.Join(base, "bin")
	if err := os.MkdirAll(binDir, 0700); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(base, "docker.log")
	docker := "#!/bin/sh\nif [ \"$1 $2\" = 'context show' ]; then echo default; exit 0; fi\necho \"$@\" >> \"$GOONCAVE_DOCKER_TEST_LOG\"\n"
	if err := os.WriteFile(filepath.Join(binDir, "docker"), []byte(docker), 0700); err != nil {
		t.Fatal(err)
	}
	blockedDataHome := filepath.Join(base, "blocked-data-home")
	if err := os.WriteFile(blockedDataHome, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(base, "config"))
	t.Setenv("XDG_DATA_HOME", blockedDataHome)
	t.Setenv("GOONCAVE_DOCKER_TEST_LOG", logPath)
	t.Setenv("DOCKER_CONTEXT", "")
	appImage, taggerImage = "ghcr.io/liukscot/gooncave:abc123", "ghcr.io/liukscot/gooncave-tagger:abc123"
	t.Cleanup(func() { appImage, taggerImage = "", "" })
	if err := run(nil, io.Discard, false); err == nil {
		t.Fatal("launcher failure was accepted")
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(commands), " up -d") {
		t.Fatalf("containers started before the launcher was installed: %s", commands)
	}
}

func TestInstallMenuAndUninstallKeepData(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("Linux desktop test")
	}
	validator, _ := exec.LookPath("desktop-file-validate")
	base := filepath.Join(t.TempDir(), "user folder")
	configHome := filepath.Join(base, "config")
	dataHome := filepath.Join(base, "share")
	binDir := filepath.Join(base, "bin")
	if err := os.MkdirAll(binDir, 0700); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(base, "docker.log")
	docker := filepath.Join(binDir, "docker")
	if err := os.WriteFile(docker, []byte("#!/bin/sh\nif [ \"$1 $2\" = 'context show' ]; then echo \"$GOONCAVE_FAKE_CONTEXT\"; exit 0; fi\necho \"$@\" >> \"$GOONCAVE_DOCKER_TEST_LOG\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_DATA_HOME", dataHome)
	t.Setenv("GOONCAVE_DOCKER_TEST_LOG", logPath)
	t.Setenv("GOONCAVE_FAKE_CONTEXT", "desktop-linux")
	appImage, taggerImage = "ghcr.io/liukscot/gooncave:abc123", "ghcr.io/liukscot/gooncave-tagger:abc123"
	t.Cleanup(func() { appImage, taggerImage = "", "" })
	var installOutput strings.Builder
	if err := run(nil, &installOutput, false); err != nil {
		t.Fatal(err)
	}
	installDir := filepath.Join(configHome, "GoonCave")
	if content, err := os.ReadFile(filepath.Join(installDir, "docker-context")); err != nil || string(content) != "desktop-linux\n" {
		t.Fatalf("Docker context was not saved: %q, %v", content, err)
	}
	installed := filepath.Join(installDir, "gooncave")
	uninstallLink := filepath.Join(installDir, "Uninstall GoonCave")
	for _, want := range []string{"GoonCave is ready", "Open in browser: http://localhost:4100", "Program folder and uninstaller:\n  " + installDir, "Data and media library:\n  " + filepath.Join(installDir, "data")} {
		if !strings.Contains(installOutput.String(), want) {
			t.Fatalf("installation summary missing %q: %s", want, installOutput.String())
		}
	}
	menu := filepath.Join(dataHome, "applications", "io.github.liukscot.GoonCave.desktop")
	for _, path := range []string{installed, uninstallLink, menu} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("installed file missing %s: %v", path, err)
		}
	}
	if target, err := os.Readlink(uninstallLink); err != nil || target != "gooncave" {
		t.Fatalf("uninstall link points to %q: %v", target, err)
	}
	if got := launcherArgs(uninstallLink, nil); len(got) != 1 || got[0] != "uninstall" {
		t.Fatalf("uninstall link launched with %v", got)
	}
	entry, err := os.ReadFile(menu)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(entry), "Terminal=true") || !strings.Contains(string(entry), "\""+installed+"\" --terminal") {
		t.Fatalf("shortcut does not launch the executable: %s", entry)
	}
	if validator != "" {
		if output, err := exec.Command(validator, menu).CombinedOutput(); err != nil {
			t.Fatalf("invalid menu entry: %s: %v", output, err)
		}
	}
	dataPath := filepath.Join(installDir, "data", "storage", "keep.txt")
	if err := os.WriteFile(dataPath, []byte("personal data"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOONCAVE_FAKE_CONTEXT", "default")
	if err := run([]string{"stop"}, io.Discard, false); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"uninstall"}, io.Discard, false); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{installed, uninstallLink, menu} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("file was not removed %s: %v", path, err)
		}
	}
	data, err := os.ReadFile(dataPath)
	if err != nil || string(data) != "personal data" {
		t.Fatalf("data was removed or changed: %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(installDir, "uninstalled")); err != nil {
		t.Fatalf("installation was not marked as removed: %v", err)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(commands), " up -d") || !strings.Contains(string(commands), " down --rmi all\n") {
		t.Fatalf("Docker was not started and stopped: %s", commands)
	}
	if !strings.Contains(string(commands), "--context desktop-linux compose") {
		t.Fatalf("the saved Docker context was not used: %s", commands)
	}
	if strings.Contains(string(commands), "--context default") {
		t.Fatalf("the active context replaced the saved one: %s", commands)
	}
	appImage, taggerImage = "ghcr.io/liukscot/gooncave:new123", "ghcr.io/liukscot/gooncave-tagger:new123"
	if err := run(nil, io.Discard, false); err != nil {
		t.Fatalf("reinstall with retained data failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(installDir, "uninstalled")); !os.IsNotExist(err) {
		t.Fatalf("uninstall marker remained after reinstall: %v", err)
	}
	newCompose, err := os.ReadFile(filepath.Join(installDir, "compose.yaml"))
	if err != nil || !strings.Contains(string(newCompose), "gooncave:new123") {
		t.Fatalf("new image was not installed: %q, %v", newCompose, err)
	}
	previous, err := os.ReadFile(filepath.Join(installDir, "compose.yaml.previous"))
	if err != nil || !strings.Contains(string(previous), "gooncave:abc123") {
		t.Fatalf("old configuration was not backed up: %q, %v", previous, err)
	}
	if data, err := os.ReadFile(dataPath); err != nil || string(data) != "personal data" {
		t.Fatalf("reinstall changed personal data: %q, %v", data, err)
	}
}

func TestUninstallQuestions(t *testing.T) {
	for _, test := range []struct {
		name      string
		answers   string
		confirmed bool
		keepData  bool
	}{
		{"cancel", "no\n", false, true},
		{"keep by default", "yes\n\n", true, true},
		{"keep explicitly", "yes\nyes\n", true, true},
		{"delete explicitly", "yes\nno\n", true, false},
		{"invalid then delete", "yes\nmaybe\nno\n", true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output strings.Builder
			confirmed, keepData := confirmUninstall(bufio.NewReader(strings.NewReader(test.answers)), &output)
			if confirmed != test.confirmed || keepData != test.keepData {
				t.Fatalf("got confirmed=%v keepData=%v", confirmed, keepData)
			}
			if confirmed && (!strings.Contains(output.String(), "Uninstall GoonCave?") || !strings.Contains(output.String(), "Keep your database and media library?")) {
				t.Fatalf("questions missing: %s", output.String())
			}
		})
	}
}

func TestUninstallCanRemoveData(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("Linux desktop test")
	}
	base := t.TempDir()
	configHome := filepath.Join(base, "config")
	binDir := filepath.Join(base, "bin")
	if err := os.MkdirAll(binDir, 0700); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(base, "docker.log")
	if err := os.WriteFile(filepath.Join(binDir, "docker"), []byte("#!/bin/sh\nif [ \"$1 $2\" = 'context show' ]; then echo desktop-linux; exit 0; fi\necho \"$@\" >> \"$GOONCAVE_DOCKER_TEST_LOG\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_DATA_HOME", filepath.Join(base, "share"))
	t.Setenv("GOONCAVE_DOCKER_TEST_LOG", logPath)
	appImage, taggerImage = "ghcr.io/liukscot/gooncave:abc123", "ghcr.io/liukscot/gooncave-tagger:abc123"
	t.Cleanup(func() { appImage, taggerImage = "", "" })
	if err := run(nil, io.Discard, false); err != nil {
		t.Fatal(err)
	}
	installDir := filepath.Join(configHome, "GoonCave")
	dataPath := filepath.Join(installDir, "data", "storage", "keep.txt")
	if err := os.WriteFile(dataPath, []byte("delete me"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"uninstall"}, io.Discard, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dataPath); !os.IsNotExist(err) {
		t.Fatalf("data was not deleted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(installDir, "compose.yaml")); !os.IsNotExist(err) {
		t.Fatalf("configuration was not deleted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(installDir, "docker-context")); !os.IsNotExist(err) {
		t.Fatalf("Docker context was not deleted: %v", err)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(commands), " down --rmi all -v") {
		t.Fatalf("Docker images or volume were not removed: %s", commands)
	}
}

func TestUninstallRefusesLinkedDataDirectory(t *testing.T) {
	base := t.TempDir()
	installDir := filepath.Join(base, "GoonCave")
	external := filepath.Join(base, "external-data")
	if err := os.MkdirAll(installDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(external, 0700); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(external, "keep.txt")
	if err := os.WriteFile(keep, []byte("personal data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(installDir, "data")); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if err := deleteInstallationData(installDir); err == nil {
		t.Fatal("linked data directory was accepted")
	}
	if content, err := os.ReadFile(keep); err != nil || string(content) != "personal data" {
		t.Fatalf("external data was changed: %q, %v", content, err)
	}
}
