package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/klondikemarlen/omp-instance-control/linux"
	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const restoreHelp = `Usage:
  ompi restore [--profile NAME] [--list [--json]]
  ompi restore NAME [--profile NAME]
  ompi restore save NAME --instance ID [--profile NAME]
  ompi restore --help | --version

Names identify persistent slots that follow their current session and working directory.
Name-to-slot bindings cannot be overwritten. Saving requires a live managed instance.
`

type restoreOptions struct {
	profile     string
	instance    string
	list        bool
	json        bool
	help        bool
	version     bool
	positionals []string
}

func runRestore(args []string) (int, error) {
	options, err := parseRestoreOptions(args)
	if err != nil {
		return 0, usageError(err.Error())
	}
	if options.help && options.version {
		return 0, usageError("choose either --help or --version")
	}
	if options.version {
		fmt.Printf("ompi %s\n", version)
		return 0, nil
	}
	if options.help {
		fmt.Print(restoreHelp)
		return 0, nil
	}
	if err := validateRestoreOptions(options); err != nil {
		return 0, usageError(err.Error())
	}
	scope, err := protocol.GetScope(options.profile, "")
	if err != nil {
		return 1, err
	}
	if len(options.positionals) > 0 && options.positionals[0] == "save" {
		return saveNamedSession(scope, options.positionals[1], options.instance)
	}

	sessions, err := linux.ListSavedSessions(scope)
	if err != nil {
		return 1, err
	}
	if options.list {
		return printSavedSessions(sessions, options.json), nil
	}
	if len(sessions) == 0 {
		return 1, errors.New("no named saved sessions in this scope; save one with 'ompi restore save NAME --instance ID'")
	}

	var selected protocol.NamedSession
	if len(options.positionals) == 1 {
		for _, session := range sessions {
			if session.Name == options.positionals[0] {
				selected = session
				break
			}
		}
		if selected.Name == "" {
			return 1, fmt.Errorf("no saved session named %q in this scope", safeTerminalText(options.positionals[0]))
		}
		if err := requireRestoreAvailable(selected); err != nil {
			return 1, err
		}
		confirmed, err := confirmNamedRestore(os.Stdin, os.Stdout, selected)
		if err != nil {
			return 1, err
		}
		if !confirmed {
			fmt.Println("Restore cancelled.")
			return 0, nil
		}
	} else {
		if !hasRestoreTerminal(os.Stdin) || !hasRestoreTerminal(os.Stdout) {
			return 1, errors.New("interactive restore menu requires a terminal; use 'ompi restore NAME' to select a saved session")
		}
		var confirmed bool
		selected, confirmed, err = chooseNamedRestore(bufio.NewReader(os.Stdin), os.Stdout, sessions)
		if err != nil {
			return 1, err
		}
		if err := requireRestoreAvailable(selected); err != nil {
			return 1, err
		}
		if !confirmed {
			fmt.Println("Restore cancelled.")
			return 0, nil
		}
	}

	executable, err := os.Executable()
	if err != nil {
		return 1, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return 1, err
	}
	code, err := linux.RestoreNamedSession(scope, selected.Name, resolveExtension(executable))
	if err != nil {
		return 1, err
	}
	return code, nil
}

func parseRestoreOptions(args []string) (restoreOptions, error) {
	var options restoreOptions
	for index := 0; index < len(args); index++ {
		argument := args[index]
		switch {
		case argument == "--profile":
			value, next, err := restoreOptionValue(args, index, "--profile")
			if err != nil {
				return restoreOptions{}, err
			}
			options.profile = value
			index = next
		case strings.HasPrefix(argument, "--profile="):
			options.profile = strings.TrimPrefix(argument, "--profile=")
		case argument == "--instance":
			value, next, err := restoreOptionValue(args, index, "--instance")
			if err != nil {
				return restoreOptions{}, err
			}
			options.instance = value
			index = next
		case strings.HasPrefix(argument, "--instance="):
			options.instance = strings.TrimPrefix(argument, "--instance=")
		case argument == "--list":
			options.list = true
		case argument == "--json":
			options.json = true
		case argument == "--help" || argument == "-h":
			options.help = true
		case argument == "--version":
			options.version = true
		case strings.HasPrefix(argument, "-"):
			return restoreOptions{}, fmt.Errorf("unknown restore option %q", argument)
		default:
			options.positionals = append(options.positionals, argument)
		}
	}
	return options, nil
}

func restoreOptionValue(args []string, index int, option string) (string, int, error) {
	if index+1 >= len(args) || strings.HasPrefix(args[index+1], "-") {
		return "", index, fmt.Errorf("%s requires a value", option)
	}
	return args[index+1], index + 1, nil
}

func validateRestoreOptions(options restoreOptions) error {
	if options.help {
		return nil
	}
	if options.list {
		if len(options.positionals) != 0 || options.instance != "" {
			return errors.New("--list cannot be combined with a name or --instance")
		}
		return nil
	}
	if options.json {
		return errors.New("--json is only valid with --list")
	}
	if len(options.positionals) == 0 {
		if options.instance != "" {
			return errors.New("--instance is only valid with 'save NAME'")
		}
		return nil
	}
	if options.positionals[0] == "save" {
		if len(options.positionals) != 2 || options.instance == "" {
			return errors.New("use 'ompi restore save NAME --instance ID'")
		}
		if err := protocol.ValidateRestoreName(options.positionals[1]); err != nil {
			return err
		}
		if err := protocol.ValidateInstanceID(options.instance); err != nil {
			return fmt.Errorf("invalid --instance ID: %w", err)
		}
		return nil
	}
	if len(options.positionals) != 1 || options.instance != "" {
		return errors.New("restore accepts one saved name; --instance is only valid with save")
	}
	return protocol.ValidateRestoreName(options.positionals[0])
}

func saveNamedSession(scope protocol.Scope, name, instanceID string) (int, error) {
	transport, err := linux.NewTransport(scope)
	if err != nil {
		return 1, err
	}
	records, err := transport.ReadRecords()
	if err != nil {
		return 1, err
	}
	var selected *protocol.Record
	for index := range records {
		if records[index].InstanceID == instanceID {
			record := records[index]
			selected = &record
			break
		}
	}
	if selected == nil {
		return 1, fmt.Errorf("no managed instance %s is registered in this scope", safeTerminalText(instanceID))
	}
	if !selected.LauncherManaged || selected.RestoreID == "" || selected.SessionFile == nil || selected.SessionID == "" {
		return 1, errors.New("selected instance is not a launcher-managed session with a persisted transcript")
	}
	request, err := protocol.CreateRequest(selected.InstanceID, "status")
	if err != nil {
		return 1, err
	}
	response, err := transport.Request(context.Background(), *selected, request)
	if err != nil {
		return 1, fmt.Errorf("status-probe selected instance before saving: %w", err)
	}
	if !response.OK {
		message := "status request was rejected"
		if response.Error != nil && response.Error.Message != "" {
			message = safeTerminalText(response.Error.Message)
		}
		return 1, fmt.Errorf("status-probe selected instance before saving: %s", message)
	}
	if !currentStatusMatchesRecord(response.Data, *selected, scope) {
		return 1, errors.New("status-probe selected instance before saving returned a different or incomplete live session")
	}
	snapshot, err := linux.SavedSessionForRestoreID(scope, selected.RestoreID)
	if err != nil {
		return 1, fmt.Errorf("selected instance has no safe persisted restore snapshot: %w", err)
	}
	agentOwner, err := linux.NewRestoreOwner(selected.PID)
	if err != nil {
		return 1, fmt.Errorf("cannot verify the selected OMP process identity after its status probe: %w", err)
	}
	if agentOwner != snapshot.AgentOwner {
		return 1, errors.New("selected instance changed process identity after its status probe; no name was saved")
	}
	if snapshot.AgentOwner.PID != selected.PID ||
		snapshot.SessionFile != *selected.SessionFile || snapshot.SessionID != selected.SessionID || snapshot.CWD != selected.CWD ||
		response.Data.SessionFile == nil || snapshot.SessionFile != *response.Data.SessionFile ||
		snapshot.SessionID != response.Data.SessionID || snapshot.CWD != response.Data.CWD {
		return 1, errors.New("selected instance status does not match its latest persisted restore snapshot")
	}
	if err := linux.SaveRestoreName(scope, name, selected.RestoreID); err != nil {
		return 1, err
	}
	fmt.Printf("Saved %s -> %s at %s\n", safeTerminalText(name), safeTerminalText(snapshot.SessionID), safeTerminalText(snapshot.CWD))
	return 0, nil
}

func currentStatusMatchesRecord(data *protocol.Data, record protocol.Record, scope protocol.Scope) bool {
	if data == nil || data.Version != protocol.Version || data.InstanceID != record.InstanceID ||
		data.Scope != scope.ID || data.PID != record.PID || !data.LauncherManaged ||
		data.CWD != record.CWD || data.SessionID != record.SessionID || data.SessionFile == nil || record.SessionFile == nil {
		return false
	}
	return *data.SessionFile == *record.SessionFile
}

func printSavedSessions(sessions []protocol.NamedSession, jsonOutput bool) int {
	if jsonOutput {
		if err := json.NewEncoder(os.Stdout).Encode(sessions); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	if len(sessions) == 0 {
		fmt.Println("No named saved sessions in this scope.")
		return 0
	}
	for index, session := range sessions {
		if session.Unavailable != "" {
			fmt.Printf("%d) %s  unavailable: %s\n", index+1, safeTerminalText(session.Name), safeTerminalText(session.Unavailable))
			continue
		}
		fmt.Printf("%d) %s  %s  %s\n", index+1, safeTerminalText(session.Name), safeTerminalText(session.Session.SessionID), safeTerminalText(session.Session.CWD))
	}
	return 0
}

func chooseNamedRestore(input io.Reader, output io.Writer, sessions []protocol.NamedSession) (protocol.NamedSession, bool, error) {
	reader := bufio.NewReader(input)
	for {
		for index, session := range sessions {
			if session.Unavailable != "" {
				fmt.Fprintf(output, "%d) %s  unavailable: %s\n", index+1, safeTerminalText(session.Name), safeTerminalText(session.Unavailable))
				continue
			}
			fmt.Fprintf(output, "%d) %s  %s  %s\n", index+1, safeTerminalText(session.Name), safeTerminalText(session.Session.SessionID), safeTerminalText(session.Session.CWD))
		}
		fmt.Fprint(output, "Choose a saved session number, or q to cancel: ")
		line, err := reader.ReadString('\n')
		choice := strings.TrimSpace(line)
		if err != nil && !errors.Is(err, io.EOF) {
			return protocol.NamedSession{}, false, err
		}
		if choice == "" || strings.EqualFold(choice, "q") {
			return protocol.NamedSession{}, false, nil
		}
		index, parseErr := strconv.Atoi(choice)
		if parseErr != nil || index < 1 || index > len(sessions) {
			if errors.Is(err, io.EOF) {
				return protocol.NamedSession{}, false, nil
			}
			fmt.Fprintln(output, "Enter a listed number or q to cancel.")
			continue
		}
		selected := sessions[index-1]
		if selected.Unavailable != "" {
			fmt.Fprintf(output, "Saved session %s unavailable: %s\n", safeTerminalText(selected.Name), safeTerminalText(selected.Unavailable))
			return selected, false, nil
		}
		confirmed, confirmErr := confirmNamedRestore(reader, output, selected)
		return selected, confirmed, confirmErr
	}
}

func requireRestoreAvailable(session protocol.NamedSession) error {
	if session.Unavailable == "" {
		return nil
	}
	return fmt.Errorf("saved session %q is unavailable: %s", safeTerminalText(session.Name), safeTerminalText(session.Unavailable))
}

func confirmNamedRestore(input io.Reader, output io.Writer, session protocol.NamedSession) (bool, error) {
	fmt.Fprintf(output, "Restore %s (session %s) at %s? [y/N]: ", safeTerminalText(session.Name), safeTerminalText(session.Session.SessionID), safeTerminalText(session.Session.CWD))
	reader, ok := input.(*bufio.Reader)
	if !ok {
		reader = bufio.NewReader(input)
	}
	line, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	answer := strings.TrimSpace(line)
	return strings.EqualFold(answer, "y") || strings.EqualFold(answer, "yes"), nil
}

func hasRestoreTerminal(file *os.File) bool {
	_, _, ok := linux.TerminalSize(file)
	return ok
}
