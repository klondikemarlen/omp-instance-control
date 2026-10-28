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

const controlHelp = `Usage:
  ompi control [help [COMMAND] | version]
  ompi control list [--profile NAME] [--json]
  ompi control restart ID|all [--profile NAME] [--json] [--no-wait]
  ompi control cleanup [--profile NAME] [--json]
  ompi control restore ...

Restart IDs may be unique lowercase hexadecimal prefixes.
Every target replaces its native ompi wrapper and OMP using the installed code.
Restarts inject zero model messages. OMP settles active work and typed
instructions queued while busy before the session reopens for input; explicit
exit suppresses relaunch.

Restart argv replays recognized OMP options but not startup prompts. Unknown
long options followed by a value-like token disable controlled restart unless
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
	if len(args) > 0 && args[0] == "control" {
		return runControl(args[1:])
	}
	executable, err := os.Executable()
	if err != nil {
		return 1, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return 1, err
	}
	code, err := linux.Launch(args, resolveExtension(executable), version)
	if err != nil {
		return 1, err
	}
	if code == 0 && len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Fprintln(os.Stdout, "\nInstance control: ompi control list|restart ID|all|cleanup\nSaved sessions: ompi control restore")
	}
	return code, nil
}

func runControl(args []string) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Print(controlHelp)
		return 0, nil
	}
	if len(args) == 1 && args[0] == "--version" {
		fmt.Printf("ompi %s\n", version)
		return 0, nil
	}
	if len(args) == 0 {
		fmt.Print(controlHelp)
		return 0, nil
	}
	if args[0] == "help" {
		if len(args) > 2 {
			return 0, usageError("use 'ompi control help [COMMAND]'")
		}
		if len(args) == 1 {
			fmt.Print(controlHelp)
			return 0, nil
		}
		switch args[1] {
		case "list":
			fmt.Println("Usage: ompi control list [--profile NAME] [--json]")
		case "restart":
			fmt.Println("Usage: ompi control restart ID|all [--profile NAME] [--json] [--no-wait]\n  ID may be a unique lowercase hexadecimal prefix.\n  Every target replaces its native ompi wrapper and OMP using the installed code.\n  Restarts inject zero model messages. OMP settles active work and typed instructions queued while busy before the session reopens for input.\n  Explicit exit suppresses relaunch.")
		case "cleanup":
			fmt.Println("Usage: ompi control cleanup [--profile NAME] [--json]")
		case "restore":
			fmt.Print(restoreHelp)
		case "version":
			fmt.Println("Usage: ompi control version")
		default:
			return 0, usageError("unknown control command " + args[1])
		}
		return 0, nil
	}
	if args[0] == "version" {
		if len(args) != 1 {
			return 0, usageError("'version' does not accept arguments")
		}
		fmt.Printf("ompi %s\n", version)
		return 0, nil
	}
	if args[0] == "restore" {
		return runRestore(args[1:])
	}
	return runControlAction(args)
}

func splitControlArguments(args []string) ([]string, []string) {
	options := make([]string, 0, len(args))
	positionals := make([]string, 0, 1)
	for index := 0; index < len(args); index++ {
		argument := args[index]
		if argument == "--profile" {
			options = append(options, argument)
			if index+1 < len(args) {
				index++
				options = append(options, args[index])
			}
			continue
		}
		if argument == "--" {
			positionals = append(positionals, args[index+1:]...)
			break
		}
		if strings.HasPrefix(argument, "-") {
			options = append(options, argument)
			continue
		}
		positionals = append(positionals, argument)
	}
	return options, positionals
}

func runControlAction(args []string) (int, error) {
	action := args[0]
	if action != "list" && action != "restart" && action != "cleanup" {
		return 0, usageError("use 'ompi control list', 'ompi control restart ID|all', 'ompi control cleanup', or 'ompi control restore ...'")
	}

	optionArgs, positionals := splitControlArguments(args[1:])
	flags := flag.NewFlagSet("ompi control "+action, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	profile := flags.String("profile", "", "OMP profile")
	jsonOutput := flags.Bool("json", false, "JSON output")
	var noWait bool
	if action == "restart" {
		flags.BoolVar(&noWait, "no-wait", false, "return after restart requests are accepted")
	}
	help := flags.Bool("help", false, "show command help")
	flags.BoolVar(help, "h", false, "show command help")
	showVersion := flags.Bool("version", false, "show wrapper version")
	if err := flags.Parse(optionArgs); err != nil {
		return 0, usageError(err.Error())
	}
	if *help && *showVersion {
		return 0, usageError("choose either --help or --version")
	}
	if *help {
		switch action {
		case "list":
			fmt.Println("Usage: ompi control list [--profile NAME] [--json]")
		case "restart":
			fmt.Println("Usage: ompi control restart ID|all [--profile NAME] [--json] [--no-wait]\n  ID may be a unique lowercase hexadecimal prefix.\n  Every target replaces its native ompi wrapper and OMP using the installed code.\n  Restarts inject zero model messages. OMP settles active work and typed instructions queued while busy before the session reopens for input.\n  Explicit exit suppresses relaunch.")
		case "cleanup":
			fmt.Println("Usage: ompi control cleanup [--profile NAME] [--json]")
		}
		return 0, nil
	}
	if *showVersion {
		fmt.Printf("ompi %s\n", version)
		return 0, nil
	}
	remaining := append(positionals, flags.Args()...)
	instanceID := ""
	all := false
	if action == "restart" {
		var err error
		all, instanceID, err = parseRestartTarget(remaining)
		if err != nil {
			return 0, usageError(err.Error())
		}
	} else if len(remaining) != 0 {
		return 0, usageError("unexpected positional argument")
	}
	scope, err := protocol.GetScope(*profile, "")
	if err != nil {
		return 0, err
	}
	transport, err := linux.NewTransport(scope)
	if err != nil {
		return 0, err
	}
	if action == "cleanup" {
		results, err := transport.CleanupRecords()
		if err != nil {
			return 1, err
		}
		return printCleanupResults(results, *jsonOutput), nil
	}
	if action == "list" {
		rows, err := cli.ListInstances(transport)
		if err != nil {
			return 0, err
		}
		return printRows(rows, *jsonOutput), nil
	}
	return runRestart(transport, all, instanceID, *jsonOutput, noWait)
}

func parseRestartTarget(positionals []string) (bool, string, error) {
	if len(positionals) != 1 {
		return false, "", errors.New("restart requires exactly one target: ID or all")
	}
	instanceID := positionals[0]
	if instanceID == "all" {
		return true, "", nil
	}
	if len(instanceID) == 0 || len(instanceID) > 32 || strings.Trim(instanceID, "0123456789abcdef") != "" {
		return false, "", errors.New("invalid restart ID: use 1-32 lowercase hexadecimal characters")
	}
	return false, instanceID, nil
}

func resolveExtension(executable string) string {
	directory := filepath.Dir(executable)
	if filepath.Base(directory) == "dist" {
		return filepath.Join(filepath.Dir(directory), "omp", "index.js")
	}
	return filepath.Join(filepath.Dir(directory), "share", "omp-instance-control", "omp", "index.js")
}

func printRows(rows []cli.Row, jsonOutput bool) int {
	if jsonOutput {
		if err := json.NewEncoder(os.Stdout).Encode(rows); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	} else if len(rows) == 0 {
		fmt.Println("No participating instances in this scope.")
	} else {
		fmt.Println(cli.FormatRows(rows))
		unreachable, reachable := 0, 0
		for _, row := range rows {
			switch row.Status {
			case "unreachable":
				unreachable++
			case "online", "restarted":
				reachable++
			}
		}
		if unreachable > 0 {
			fmt.Fprintf(os.Stderr, "%d unreachable registration(s), %d reachable; entries may be stale. Run ompi control cleanup for safe cleanup; --json retains full diagnostics.\n", unreachable, reachable)
		}
	}
	return restartExitCode(rows, false)
}

func restartExitCode(rows []cli.Row, waiting bool) int {
	for _, row := range rows {
		if row.Status == "failed" || row.Status == "unreachable" || row.Status == "unknown" || row.Status == "blocked" {
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
