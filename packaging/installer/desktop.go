package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func installedBinaryPath(configDir string) (string, error) {
	if runtime.GOOS == "windows" {
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			return "", errors.New("LOCALAPPDATA is unavailable: cannot install the Windows shortcut")
		}
		return filepath.Join(local, "GoonCave", "gooncave.exe"), nil
	}
	return filepath.Join(configDir, "gooncave"), nil
}

func installLauncher(configDir string) error {
	installed, err := installedBinaryPath(configDir)
	if err != nil {
		return err
	}
	if err := copyInstaller(installed); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return createWindowsShortcuts(installed, configDir)
	}
	return createLinuxShortcuts(installed)
}

func copyInstaller(destination string) error {
	source, err := os.Executable()
	if err != nil {
		return fmt.Errorf("find the executable: %w", err)
	}
	if source == destination {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return fmt.Errorf("create the program directory: %w", err)
	}
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("read the installer: %w", err)
	}
	defer input.Close()
	if runtime.GOOS == "windows" {
		if installed, err := os.Open(destination); err == nil {
			defer installed.Close()
			same, err := sameContent(input, installed)
			if err != nil {
				return err
			}
			if same {
				return nil
			}
			return errors.New("a different Windows executable is already installed; uninstall the old version and try again. Your data will remain intact")
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("check the existing executable: %w", err)
		}
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".gooncave-*")
	if err != nil {
		return fmt.Errorf("prepare the executable: %w", err)
	}
	defer os.Remove(temporary.Name())
	if _, err := io.Copy(temporary, input); err != nil {
		temporary.Close()
		return fmt.Errorf("copy the executable: %w", err)
	}
	if err := temporary.Chmod(0700); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary.Name(), destination); err != nil {
		return fmt.Errorf("install the executable: %w", err)
	}
	return nil
}

func sameContent(first, second io.Reader) (bool, error) {
	firstHash := sha256.New()
	secondHash := sha256.New()
	if _, err := io.Copy(firstHash, first); err != nil {
		return false, err
	}
	if _, err := io.Copy(secondHash, second); err != nil {
		return false, err
	}
	return string(firstHash.Sum(nil)) == string(secondHash.Sum(nil)), nil
}

func linuxApplicationsDir() (string, error) {
	dataHome := os.Getenv("XDG_DATA_HOME")
	if !filepath.IsAbs(dataHome) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dataHome = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(dataHome, "applications"), nil
}

func linuxDesktopEntry(name, binary, arguments string) string {
	quoted := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%", "$", "\\$", "`", "\\`").Replace(binary)
	return "[Desktop Entry]\nType=Application\nName=" + name + "\nExec=\"" + quoted + "\" --terminal " + arguments + "\nTerminal=true\nCategories=Utility;\n"
}

func createLinuxShortcuts(binary string) error {
	applications, err := linuxApplicationsDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(applications, 0755); err != nil {
		return fmt.Errorf("create the application menu directory: %w", err)
	}
	entries := map[string]string{
		"io.github.liukscot.GoonCave.desktop":           linuxDesktopEntry("GoonCave", binary, ""),
		"io.github.liukscot.GoonCave.Uninstall.desktop": linuxDesktopEntry("Uninstall GoonCave", binary, "uninstall"),
	}
	for name, content := range entries {
		if err := os.WriteFile(filepath.Join(applications, name), []byte(content), 0644); err != nil {
			return fmt.Errorf("create the menu entry %s: %w", name, err)
		}
	}
	link := filepath.Join(filepath.Dir(binary), "Uninstall GoonCave")
	if existing, err := os.Readlink(link); err == nil {
		if existing != filepath.Base(binary) {
			return fmt.Errorf("the uninstall link already points to %s", existing)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("check the uninstall link: %w", err)
	}
	if err := os.Symlink(filepath.Base(binary), link); err != nil {
		return fmt.Errorf("create the uninstall link: %w", err)
	}
	return nil
}

func windowsShortcutsDir() (string, error) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return "", errors.New("APPDATA is unavailable: cannot create the Windows menu")
	}
	return filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "GoonCave"), nil
}

func createWindowsShortcuts(binary, configDir string) error {
	menu, err := windowsShortcutsDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(menu, 0700); err != nil {
		return fmt.Errorf("create the Windows menu directory: %w", err)
	}
	shortcuts := []struct{ path, arguments string }{
		{filepath.Join(menu, "GoonCave.lnk"), "--terminal"},
		{filepath.Join(menu, "Uninstall GoonCave.lnk"), "--terminal uninstall"},
		{filepath.Join(filepath.Dir(binary), "Uninstall GoonCave.lnk"), "--terminal uninstall"},
	}
	for _, shortcut := range shortcuts {
		command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut($env:GOONCAVE_SHORTCUT); $link.TargetPath=$env:GOONCAVE_BINARY; $link.Arguments=$env:GOONCAVE_ARGUMENTS; $link.WorkingDirectory=$env:GOONCAVE_DIRECTORY; $link.Save()`)
		command.Env = append(os.Environ(), "GOONCAVE_SHORTCUT="+shortcut.path, "GOONCAVE_BINARY="+binary, "GOONCAVE_ARGUMENTS="+shortcut.arguments, "GOONCAVE_DIRECTORY="+configDir)
		if output, err := command.CombinedOutput(); err != nil {
			return fmt.Errorf("create the shortcut %s: %s: %w", shortcut.path, strings.TrimSpace(string(output)), err)
		}
	}
	if err := removeIfPresent(filepath.Join(menu, "Disinstalla GoonCave.lnk")); err != nil {
		return err
	}
	return nil
}

func removeLauncher(configDir string) error {
	installed, err := installedBinaryPath(configDir)
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		if err := removeIfPresent(filepath.Join(filepath.Dir(installed), "Uninstall GoonCave.lnk")); err != nil {
			return err
		}
		menu, err := windowsShortcutsDir()
		if err != nil {
			return err
		}
		for _, name := range []string{"GoonCave.lnk", "Uninstall GoonCave.lnk", "Disinstalla GoonCave.lnk"} {
			if err := removeIfPresent(filepath.Join(menu, name)); err != nil {
				return err
			}
		}
		if err := os.Remove(menu); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove the menu directory: %w", err)
		}
	} else {
		link := filepath.Join(filepath.Dir(installed), "Uninstall GoonCave")
		if target, err := os.Readlink(link); err == nil {
			if target != filepath.Base(installed) {
				return fmt.Errorf("refusing to remove an unrelated uninstall link: %s", target)
			}
			if err := os.Remove(link); err != nil {
				return fmt.Errorf("remove the uninstall link: %w", err)
			}
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("check the uninstall link: %w", err)
		}
		applications, err := linuxApplicationsDir()
		if err != nil {
			return err
		}
		for _, name := range []string{"io.github.liukscot.GoonCave.desktop", "io.github.liukscot.GoonCave.Uninstall.desktop"} {
			if err := removeIfPresent(filepath.Join(applications, name)); err != nil {
				return err
			}
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" && executable == installed {
		return removeWindowsExecutableAfterExit(installed)
	}
	return removeIfPresent(installed)
}

func removeIfPresent(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove %s: %w", path, err)
	}
	return nil
}

func removeWindowsExecutableAfterExit(path string) error {
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `$ErrorActionPreference='Stop'; Wait-Process -Id ([int]$env:GOONCAVE_PARENT_PID) -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $env:GOONCAVE_REMOVE -Force`)
	command.Env = append(os.Environ(), "GOONCAVE_PARENT_PID="+fmt.Sprint(os.Getpid()), "GOONCAVE_REMOVE="+path)
	if err := command.Start(); err != nil {
		return fmt.Errorf("schedule executable removal: %w", err)
	}
	return command.Process.Release()
}
