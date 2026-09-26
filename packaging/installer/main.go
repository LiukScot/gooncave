package main

import (
	"bufio"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed compose.yaml
var composeTemplate string

var appImage string
var taggerImage string

func main() {
	args := os.Args[1:]
	terminalMode := len(args) > 0 && args[0] == "--terminal"
	if terminalMode {
		args = args[1:]
	}
	args = launcherArgs(os.Args[0], args)
	insideTerminal := hasControllingTerminal()
	if !terminalMode && desktopLaunch(os.Getenv("DISPLAY"), os.Getenv("WAYLAND_DISPLAY"), insideTerminal) {
		if err := launchTerminal(args); err != nil {
			message := "Could not open a terminal: " + err.Error() + ". Run this file from a terminal to see details."
			showDesktopMessage(message, true)
			fmt.Fprintln(os.Stderr, "GoonCave:", message)
			os.Exit(1)
		}
		return
	}
	terminalMode = terminalMode || (runtime.GOOS == "linux" && insideTerminal && (os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""))
	reader := bufio.NewReader(os.Stdin)
	deleteData := false
	if len(args) == 1 && args[0] == "uninstall" {
		confirmed, keepData := confirmUninstall(reader, os.Stdout)
		if !confirmed {
			fmt.Fprintln(os.Stdout, "Uninstall cancelled.")
			if terminalMode {
				fmt.Fprintln(os.Stdout, "Press Enter to close this window.")
				_, _ = reader.ReadString('\n')
			}
			return
		}
		deleteData = !keepData
	}
	if len(args) == 1 && args[0] == "uninstall" {
		if deleteData {
			fmt.Fprintln(os.Stdout, "Removing GoonCave, its Docker images, and local data.")
		} else {
			fmt.Fprintln(os.Stdout, "Removing GoonCave and its Docker images. Your data will be kept.")
		}
	} else if len(args) == 1 && args[0] == "stop" {
		fmt.Fprintln(os.Stdout, "Stopping GoonCave.")
	} else {
		fmt.Fprintln(os.Stdout, "Starting GoonCave. Docker will show download and startup progress here.")
	}
	err := run(args, os.Stdout, deleteData)
	if err != nil {
		fmt.Fprintln(os.Stderr, "GoonCave:", err)
	}
	if terminalMode {
		fmt.Fprintln(os.Stdout, "Press Enter to close this window.")
		_, _ = reader.ReadString('\n')
	}
	if err != nil {
		os.Exit(1)
	}
}

func launcherArgs(executable string, args []string) []string {
	if len(args) == 0 && filepath.Base(executable) == "Uninstall GoonCave" {
		return []string{"uninstall"}
	}
	return args
}

func confirmUninstall(reader *bufio.Reader, output io.Writer) (bool, bool) {
	fmt.Fprint(output, "Uninstall GoonCave? Type 'yes' to confirm: ")
	answer, _ := reader.ReadString('\n')
	if strings.TrimSpace(strings.ToLower(answer)) != "yes" {
		return false, true
	}
	for {
		fmt.Fprint(output, "Keep your database and media library? Choosing 'no' permanently deletes them. [Y/n]: ")
		answer, _ = reader.ReadString('\n')
		switch strings.TrimSpace(strings.ToLower(answer)) {
		case "", "yes", "y":
			return true, true
		case "no", "n":
			return true, false
		default:
			fmt.Fprintln(output, "Please answer yes or no.")
		}
	}
}

func desktopLaunch(display, wayland string, insideTerminal bool) bool {
	return runtime.GOOS == "linux" && (display != "" || wayland != "") && !insideTerminal
}

func hasControllingTerminal() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	terminal, err := os.Open("/dev/tty")
	if err != nil {
		return false
	}
	_ = terminal.Close()
	return true
}

func launchTerminal(args []string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	commandArgs := append([]string{executable, "--terminal"}, args...)
	terminals := []struct {
		name string
		args []string
	}{
		{"ptyxis", append([]string{"--new-window", "--"}, commandArgs...)},
		{"gnome-terminal", append([]string{"--"}, commandArgs...)},
		{"konsole", append([]string{"-e"}, commandArgs...)},
		{"xfce4-terminal", append([]string{"-x"}, commandArgs...)},
		{"xterm", append([]string{"-e"}, commandArgs...)},
	}
	for _, terminal := range terminals {
		if _, err := exec.LookPath(terminal.name); err != nil {
			continue
		}
		command := exec.Command(terminal.name, terminal.args...)
		if err := command.Start(); err != nil {
			continue
		}
		return command.Process.Release()
	}
	return errors.New("no supported terminal found (Ptyxis, GNOME Terminal, Konsole, XFCE Terminal, or XTerm)")
}

func showDesktopMessage(message string, failure bool) {
	for _, dialog := range []string{"zenity", "kdialog", "notify-send"} {
		if _, err := exec.LookPath(dialog); err != nil {
			continue
		}
		var args []string
		switch dialog {
		case "zenity":
			kind := "--info"
			if failure {
				kind = "--error"
			}
			args = []string{kind, "--title=GoonCave", "--text=" + message, "--width=450"}
		case "kdialog":
			kind := "--msgbox"
			if failure {
				kind = "--error"
			}
			args = []string{kind, message, "--title", "GoonCave"}
		default:
			args = []string{"GoonCave", message}
		}
		if err := exec.Command(dialog, args...).Run(); err == nil {
			return
		}
	}
}

func run(args []string, output io.Writer, deleteData bool) error {
	if len(args) > 1 || (len(args) == 1 && args[0] != "start" && args[0] != "stop" && args[0] != "uninstall") {
		return errors.New("usage: gooncave-install [start|stop|uninstall]")
	}
	if deleteData && (len(args) != 1 || args[0] != "uninstall") {
		return errors.New("data removal is only available during uninstall")
	}
	if runtime.GOOS != "windows" && os.Getuid() == 0 {
		return errors.New("run the installer as your normal user, without sudo, so you own the data")
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return fmt.Errorf("find the configuration directory: %w", err)
	}
	installDir := filepath.Join(configDir, "GoonCave")
	composePath := filepath.Join(installDir, "compose.yaml")
	contextName, err := dockerContext(installDir)
	if err != nil {
		return err
	}
	if err := checkDocker(contextName); err != nil {
		return err
	}
	if len(args) == 1 && args[0] == "uninstall" {
		if _, err := os.Stat(composePath); err != nil {
			return errors.New("GoonCave is not installed")
		}
		composeArgs := []string{"down", "--rmi", "all"}
		if deleteData {
			composeArgs = append(composeArgs, "-v")
		}
		if err := compose(installDir, contextName, composeArgs...); err != nil {
			return err
		}
		if err := removeLauncher(installDir); err != nil {
			return err
		}
		if deleteData {
			if err := deleteInstallationData(installDir); err != nil {
				return err
			}
			fmt.Fprintln(output, "GoonCave and its local data were removed.")
		} else {
			if err := os.WriteFile(filepath.Join(installDir, "uninstalled"), nil, 0600); err != nil {
				return fmt.Errorf("mark the installation as removed: %w", err)
			}
			fmt.Fprintln(output, "GoonCave uninstalled. Configuration and data kept in", installDir)
		}
		return nil
	}
	if len(args) == 1 && args[0] == "stop" {
		if _, err := os.Stat(composePath); err != nil {
			return errors.New("GoonCave is not installed")
		}
		if err := compose(installDir, contextName, "stop"); err != nil {
			return err
		}
		fmt.Fprintln(output, "GoonCave stopped. Your data remains in", filepath.Join(installDir, "data"))
		return nil
	}
	if err := install(installDir); err != nil {
		return err
	}
	if err := saveDockerContext(installDir, contextName); err != nil {
		return err
	}
	if err := installLauncher(installDir); err != nil {
		return err
	}
	if err := compose(installDir, contextName, "up", "-d"); err != nil {
		return err
	}
	if err := removeIfPresent(filepath.Join(installDir, "uninstalled")); err != nil {
		return err
	}
	installed, err := installedBinaryPath(installDir)
	if err != nil {
		return err
	}
	menuName := "Applications menu"
	if runtime.GOOS == "windows" {
		menuName = "Start menu"
	}
	fmt.Fprintln(output, "\n========================")
	fmt.Fprintln(output, "  GoonCave is ready")
	fmt.Fprintln(output, "========================")
	fmt.Fprintln(output, "Open in browser: http://localhost:4100")
	fmt.Fprintln(output, "Start later:", menuName, "> GoonCave")
	fmt.Fprintln(output, "\nProgram folder and uninstaller:")
	fmt.Fprintln(output, " ", filepath.Dir(installed))
	fmt.Fprintln(output, "Data and media library:")
	fmt.Fprintln(output, " ", filepath.Join(installDir, "data"))
	return nil
}

func checkDocker(contextName string) error {
	for _, args := range [][]string{{"compose", "version"}, {"info", "--format", "{{.ServerVersion}}"}} {
		args = append([]string{"--context", contextName}, args...)
		command := exec.Command("docker", args...)
		if output, err := command.CombinedOutput(); err != nil {
			if errors.Is(err, exec.ErrNotFound) {
				return errors.New("Docker is not installed. Install Docker Desktop on Windows or Docker Engine with Compose on Linux")
			}
			if runtime.GOOS == "linux" && strings.Contains(strings.ToLower(string(output)), "permission denied") {
				return errors.New("your user cannot access Docker. Configure Docker access without sudo, sign out and back in, and check that 'docker info' works. Then retry. Guide: https://docs.docker.com/engine/install/linux-postinstall/")
			}
			return fmt.Errorf("Docker is unavailable or not running: %s (%w). Install and start Docker Desktop on Windows or Docker Engine with Compose on Linux", strings.TrimSpace(string(output)), err)
		}
	}
	return nil
}

func dockerContext(dir string) (string, error) {
	path := filepath.Join(dir, "docker-context")
	if content, err := os.ReadFile(path); err == nil {
		name := strings.TrimSpace(string(content))
		if name == "" || strings.ContainsAny(name, "\r\n") {
			return "", errors.New("the saved Docker context is invalid")
		}
		return name, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("read the saved Docker context: %w", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "compose.yaml")); err == nil {
		name := os.Getenv("DOCKER_CONTEXT")
		if name == "" {
			return "", errors.New("this existing installation has no saved Docker context. Set DOCKER_CONTEXT to the context that contains GoonCave and run the installer again. See available contexts with 'docker context ls'")
		}
		if strings.TrimSpace(name) != name || strings.ContainsAny(name, "\r\n") {
			return "", errors.New("DOCKER_CONTEXT contains an invalid Docker context name")
		}
		return name, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("check the existing installation: %w", err)
	}
	if os.Getenv("DOCKER_HOST") != "" && os.Getenv("DOCKER_CONTEXT") == "" {
		return "", errors.New("DOCKER_HOST overrides the active Docker context; unset DOCKER_HOST and select a Docker context before installing GoonCave")
	}
	command := exec.Command("docker", "context", "show")
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("find the active Docker context: %s: %w", strings.TrimSpace(string(output)), err)
	}
	name := strings.TrimSpace(string(output))
	if name == "" || strings.ContainsAny(name, "\r\n") {
		return "", errors.New("Docker returned an invalid active context")
	}
	return name, nil
}

func saveDockerContext(dir, name string) error {
	path := filepath.Join(dir, "docker-context")
	if content, err := os.ReadFile(path); err == nil {
		if strings.TrimSpace(string(content)) != name {
			return errors.New("the installation already uses a different Docker context")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("check the saved Docker context: %w", err)
	}
	if err := os.WriteFile(path, []byte(name+"\n"), 0600); err != nil {
		return fmt.Errorf("save the Docker context: %w", err)
	}
	return nil
}

func install(dir string) error {
	if appImage == "" || taggerImage == "" {
		return errors.New("this installer has no release images: download an official GoonCave installer")
	}
	for _, path := range []string{dir, filepath.Join(dir, "data"), filepath.Join(dir, "data", "storage"), filepath.Join(dir, "data", "library")} {
		if err := ensurePrivateDirectory(path); err != nil {
			return err
		}
	}
	path := filepath.Join(dir, "compose.yaml")
	var previous []byte
	if existing, err := os.ReadFile(path); err == nil {
		if !strings.Contains(string(existing), "image: "+appImage) || !strings.Contains(string(existing), "image: "+taggerImage) {
			if _, err := os.Stat(filepath.Join(dir, "uninstalled")); os.IsNotExist(err) {
				return errors.New("a different version is installed; uninstall it while keeping your data before installing this version")
			} else if err != nil {
				return fmt.Errorf("check the uninstall state: %w", err)
			}
			previous = existing
		} else {
			return nil
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("check the existing installation: %w", err)
	}
	uid, gid := "1000", "1000"
	if runtime.GOOS != "windows" {
		uid, gid = fmt.Sprint(os.Getuid()), fmt.Sprint(os.Getgid())
	}
	content := strings.NewReplacer("@APP_IMAGE@", appImage, "@TAGGER_IMAGE@", taggerImage, "@UID@", uid, "@GID@", gid).Replace(composeTemplate)
	if previous != nil {
		if err := os.WriteFile(filepath.Join(dir, "compose.yaml.previous"), previous, 0600); err != nil {
			return fmt.Errorf("back up the previous configuration: %w", err)
		}
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		return fmt.Errorf("write the configuration: %w", err)
	}
	return nil
}

func ensurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return fmt.Errorf("create the directory %s: %w", path, err)
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("check the directory %s: %w", path, err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing a non-directory or symbolic link at %s", path)
	}
	if err := os.Chmod(path, 0700); err != nil {
		return fmt.Errorf("protect the directory %s: %w", path, err)
	}
	return nil
}

func deleteInstallationData(dir string) error {
	if filepath.Base(dir) != "GoonCave" {
		return errors.New("refusing to delete data outside the GoonCave directory")
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("check the installation directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("the installation directory is not a regular directory; data was not deleted")
	}
	dataDir := filepath.Join(dir, "data")
	if info, err := os.Lstat(dataDir); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("the data directory is a symbolic link; data was not deleted")
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("check the data directory: %w", err)
	}
	if err := os.RemoveAll(dataDir); err != nil {
		return fmt.Errorf("delete the data directory: %w", err)
	}
	if err := removeIfPresent(filepath.Join(dir, "compose.yaml")); err != nil {
		return err
	}
	if err := removeIfPresent(filepath.Join(dir, "docker-context")); err != nil {
		return err
	}
	for _, name := range []string{"compose.yaml.previous", "uninstalled"} {
		if err := removeIfPresent(filepath.Join(dir, name)); err != nil {
			return err
		}
	}
	if entries, err := os.ReadDir(dir); err == nil && len(entries) == 0 {
		if err := os.Remove(dir); err != nil {
			return fmt.Errorf("remove the empty installation directory: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("inspect the installation directory: %w", err)
	}
	return nil
}

func compose(dir, contextName string, args ...string) error {
	command := exec.Command("docker", append([]string{"--context", contextName, "compose", "-f", filepath.Join(dir, "compose.yaml")}, args...)...)
	command.Dir = dir
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("docker compose %s: %w", strings.Join(args, " "), err)
	}
	return nil
}
