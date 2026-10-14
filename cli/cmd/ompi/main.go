package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/klondikemarlen/omp-instance-control/cli"
	"github.com/klondikemarlen/omp-instance-control/linux"
	"github.com/klondikemarlen/omp-instance-control/protocol"
)

var version = "dev"

const instancesHelp = `Usage:
  ompi instances [list] [--profile NAME] [--json]
  ompi instances restart (--all | --instance ID) [--profile NAME] [--json] [--no-wait]
  ompi instances --help
  ompi instances --version

Restart argv replays recognized OMP options but not startup prompts. Unknown
long options followed by a value-like token disable automatic restart unless
written with an explicit --option=value form.
`

func main() {
	code, err := run(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if errors.Is(err, errUsage) {
			os.Exit(2)
		}
		os.Exit(1)
	}
	os.Exit(code)
}

var errUsage = errors.New("usage")

func run(args []string) (int, error) {
	if len(args) > 0 && args[0] == "instances" {
		return runInstances(args[1:])
	}
	executable, err := os.Executable()
	if err != nil {
		return 1, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return 1, err
	}
	extension := resolveExtension(executable)
	code, err := linux.Launch(args, extension)
	if err != nil {
		return 1, err
	}
	if code == 0 && len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Fprintln(os.Stdout, "\nInstance control: ompi instances list|restart")
	}
	return code, nil
}

func resolveExtension(executable string) string {
	directory := filepath.Dir(executable)
	if filepath.Base(directory) == "dist" {
		return filepath.Join(filepath.Dir(directory), "omp", "index.js")
	}
	return filepath.Join(filepath.Dir(directory), "share", "omp-instance-control", "omp", "index.js")
}

func runInstances(args []string) (int, error) {
	action := "list"
	optionArgs := args
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action = args[0]
		optionArgs = args[1:]
	}
	if action != "list" && action != "restart" {
		return 0, usageError("use 'ompi instances list' or 'ompi instances restart'")
	}
	flags := flag.NewFlagSet("ompi instances "+action, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	profile := flags.String("profile", "", "OMP profile")
	jsonOutput := flags.Bool("json", false, "JSON output")
	all := flags.Bool("all", false, "restart all discovered instances")
	instance := flags.String("instance", "", "instance ID to restart")
	noWait := flags.Bool("no-wait", false, "return after restart requests are accepted")
	help := flags.Bool("help", false, "show instance command help")
	flags.BoolVar(help, "h", false, "show instance command help")
	showVersion := flags.Bool("version", false, "show wrapper version")
	if err := flags.Parse(optionArgs); err != nil {
		return 0, usageError(err.Error())
	}
	if *help && *showVersion {
		return 0, usageError("choose either --help or --version")
	}
	if *help {
		fmt.Print(instancesHelp)
		return 0, nil
	}
	if *showVersion {
		fmt.Printf("ompi %s\n", version)
		return 0, nil
	}
	restartOptionSet := false
	flags.Visit(func(option *flag.Flag) {
		if option.Name == "all" || option.Name == "instance" || option.Name == "no-wait" {
			restartOptionSet = true
		}
	})
	if flags.NArg() != 0 {
		return 0, usageError("unexpected positional argument")
	}
	if action == "list" && restartOptionSet {
		return 0, usageError("--all, --instance, and --no-wait are only valid with restart")
	}
	if action == "restart" && (*all == (*instance != "")) {
		return 0, usageError("choose exactly one of --all or --instance <id>")
	}
	scope, err := protocol.GetScope(*profile, "")
	if err != nil {
		return 0, err
	}
	transport, err := linux.NewTransport(scope)
	if err != nil {
		return 0, err
	}
	if action == "list" {
		rows, err := cli.ListInstances(transport)
		if err != nil {
			return 0, err
		}
		return printRows(rows, *jsonOutput), nil
	}

	return runRestart(transport, *all, *instance, *jsonOutput, *noWait)
}

func printRows(rows []cli.Row, jsonOutput bool) int {
	if jsonOutput {
		if err := json.NewEncoder(os.Stdout).Encode(rows); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	} else {
		fmt.Println(cli.FormatRows(rows))
	}
	return restartExitCode(rows, false)
}

func restartExitCode(rows []cli.Row, waiting bool) int {
	for _, row := range rows {
		if row.Status == "failed" || row.Status == "unreachable" || row.Status == "unknown" {
			return 1
		}
		if waiting && row.Status != "restarted" {
			return 1
		}
	}
	return 0
}

func usageError(message string) error {
	if strings.TrimSpace(message) == "" {
		return errUsage
	}
	return fmt.Errorf("%w: %s", errUsage, message)
}
