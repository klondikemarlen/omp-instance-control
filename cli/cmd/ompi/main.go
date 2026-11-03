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
  ompi control send [--profile NAME] [--json] ID MESSAGE
  ompi control steer [--profile NAME] [--json] ID MESSAGE
  ompi control cleanup [--profile NAME] [--json]
  ompi control restore ...
  ompi control recover FILE

Restart IDs may be unique lowercase hexadecimal prefixes.
Every target replaces its native ompi wrapper and OMP using the installed code.
Restarts inject zero model messages. OMP settles active work and typed
instructions queued while busy before the session reopens for input; explicit
exit suppresses relaunch.

Send and steer options precede ID; quote MESSAGE as one literal shell argument.
Send queues a follow-up; steer directs the active turn. A submitted
acknowledgement means handed to the host API, not processed or completed.

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
		fmt.Fprintln(os.Stdout, "\nInstance control: ompi control list|restart ID|all|cleanup\nMessages: ompi control send|steer ID MESSAGE\nSaved sessions: ompi control restore")
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
		case "send", "steer":
			fmt.Printf("Usage: ompi control %s [--profile NAME] [--json] ID MESSAGE\n  ID may be a unique lowercase hexadecimal prefix.\n  Options precede ID. Quote MESSAGE as one literal shell argument. Idle delivery starts a turn.\n", args[1])
			if args[1] == "send" {
				fmt.Println("  Queues a follow-up. Submitted means handed to the host API, not processed or completed.")
			} else {
				fmt.Println("  Steers the active turn. Submitted means handed to the host API, not processed or completed.")
			}
		case "cleanup":
			fmt.Println("Usage: ompi control cleanup [--profile NAME] [--json]")
		case "restore":
			fmt.Print(restoreHelp)
		case "recover":
			fmt.Print(recoverHelp)
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
	if args[0] == "recover" {
		return runRecover(args[1:])
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

func splitLeadingSendOptions(args []string) ([]string, []string) {
	index := 0
	for index < len(args) {
		argument := args[index]
		switch argument {
		case "--profile":
			if index+1 >= len(args) {
				return args[:index+1], nil
			}
			index += 2
		case "--json", "--help", "-h", "--version":
			index++
		default:
			if strings.HasPrefix(argument, "-") {
				index++
				continue
			}
			return args[:index], args[index:]
		}
	}
	return args, nil
}

func runControlAction(args []string) (int, error) {
	action := args[0]
	if action != "list" && action != "restart" && action != "send" && action != "steer" && action != "cleanup" {
		return 0, usageError("use 'ompi control help' for available commands")
	}

	var optionArgs, positionals []string
	if action == "send" || action == "steer" {
		optionArgs, positionals = splitLeadingSendOptions(args[1:])
	} else {
		optionArgs, positionals = splitControlArguments(args[1:])
	}
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
		case "send", "steer":
			fmt.Printf("Usage: ompi control %s [--profile NAME] [--json] ID MESSAGE\n  ID may be a unique lowercase hexadecimal prefix. MESSAGE is literal text.\n", action)
			if action == "send" {
				fmt.Println("  Queues a follow-up.")
			} else {
				fmt.Println("  Steers the active turn.")
			}
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
	var message string
	var err error
	if action == "restart" {
		all, instanceID, err = parseRestartTarget(remaining)
		if err != nil {
			return 0, usageError(err.Error())
		}
	} else if action == "send" || action == "steer" {
		instanceID, message, err = parseSendArguments(remaining, action)
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
	if action == "send" || action == "steer" {
		delivery := "followUp"
		if action == "steer" {
			delivery = "steer"
		}
		row, err := cli.SendMessage(transport, instanceID, message, delivery)
		if err != nil {
			return 1, err
		}
		return printSendRow(row, *jsonOutput), nil
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

func parseSendArguments(positionals []string, action string) (string, string, error) {
	if len(positionals) != 2 {
		return "", "", errors.New(action + " requires exactly one target and one MESSAGE argument")
	}
	instanceID, message := positionals[0], positionals[1]
	if instanceID == "all" || len(instanceID) == 0 || len(instanceID) > 32 ||
		strings.Trim(instanceID, "0123456789abcdef") != "" {
		return "", "", errors.New("invalid " + action + " ID: use 1-32 lowercase hexadecimal characters")
	}
	if strings.TrimSpace(message) == "" {
		return "", "", errors.New("message must not be empty")
	}
	if len(message) > 16*1024 {
		return "", "", errors.New("message exceeds 16 KiB")
	}
	return instanceID, message, nil
}

func printSendRow(row cli.Row, jsonOutput bool) int {
	if jsonOutput {
		encoded, err := json.Marshal(row)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Println(string(encoded))
	} else if row.Status == "submitted" && row.Data != nil {
		fmt.Printf("%s  submitted  %s  %s\n", row.InstanceID, row.Data.MessageID, row.Data.Delivery)
	} else {
		fmt.Fprintf(os.Stderr, "%s  %s\n", safeTerminalText(row.InstanceID), safeTerminalText(cli.ErrorSummary(row)))
	}
	if row.Status == "submitted" {
		return 0
	}
	return 1
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
