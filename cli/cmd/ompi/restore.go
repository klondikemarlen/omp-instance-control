package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/klondikemarlen/omp-instance-control/linux"
	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const restoreHelp = `Usage:
  ompi control restore [NAME] [--profile NAME]
  ompi control restore name NAME [--profile NAME]
  ompi control restore save NAME --instance ID [--profile NAME]
  ompi control restore slot ID [--profile NAME]
  ompi control restore list [--json] [--from ID] [--profile NAME]
  ompi control restore checkpoint [--profile NAME]
  ompi control restore history [--json] [--profile NAME]
  ompi control restore export [--from ID] [--profile NAME]
  ompi control restore import-legacy [PATH] [--profile NAME]
  ompi control restore from ID [--profile NAME]
  ompi control restore --help | --version

Recovery automatically captures persisted managed ompi slots. Names are optional.
Checkpoints retain slot membership, not frozen transcript contents.
Legacy imports are review/export data and never acquire invented ownership.
Restore uses this terminal only; no terminal windows are opened automatically.
`

type restoreOptions struct {
	profile       string
	instance      string
	slot          string
	from          string
	list          bool
	json          bool
	checkpoint    bool
	history       bool
	export        bool
	importLegacy  bool
	importPath    string
	name          bool
	fromOperation bool
	help          bool
	version       bool
	positionals   []string
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
	scope, err := protocol.GetScope(options.profile, "")
	if err != nil {
		return 1, err
	}
	if options.instance != "" {
		return saveNamedSession(scope, options.positionals[1], options.instance)
	}
	if options.name {
		return restoreNamedSession(scope, options.positionals[1])
	}
	if len(options.positionals) == 1 {
		switch options.positionals[0] {
		case "list", "history", "checkpoint", "export", "import-legacy", "slot", "from":
		default:
			return restoreNamedSession(scope, options.positionals[0])
		}
	}
	return runRecovery(scope, options)
}

func restoreNamedSession(scope protocol.Scope, name string) (int, error) {
	sessions, err := linux.ListSavedSessions(scope)
	if err != nil {
		return 1, err
	}
	var selected protocol.NamedSession
	for _, session := range sessions {
		if session.Name == name {
			selected = session
			break
		}
	}
	if selected.Name == "" {
		return 1, fmt.Errorf("no saved session named %q in this scope", safeTerminalText(name))
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
	executable, err := os.Executable()
	if err != nil {
		return 1, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return 1, err
	}
	code, err := linux.RestoreNamedSession(scope, selected.Name, resolveExtension(executable), version, selected.Session)
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
			value, next, err := restoreOptionValue(args, index, argument)
			if err != nil {
				return restoreOptions{}, err
			}
			options.profile, index = value, next
		case strings.HasPrefix(argument, "--profile="):
			options.profile = strings.TrimPrefix(argument, "--profile=")
		case argument == "--instance":
			value, next, err := restoreOptionValue(args, index, argument)
			if err != nil {
				return restoreOptions{}, err
			}
			options.instance, index = value, next
		case strings.HasPrefix(argument, "--instance="):
			options.instance = strings.TrimPrefix(argument, "--instance=")
			if options.instance == "" {
				return restoreOptions{}, errors.New("--instance requires a value")
			}
		case argument == "--from":
			value, next, err := restoreOptionValue(args, index, argument)
			if err != nil {
				return restoreOptions{}, err
			}
			options.from, index = value, next
		case strings.HasPrefix(argument, "--from="):
			options.from = strings.TrimPrefix(argument, "--from=")
			if options.from == "" {
				return restoreOptions{}, errors.New("--from requires a value")
			}
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
	options, err := normalizeRestoreWords(options)
	if err != nil {
		return restoreOptions{}, err
	}
	return options, validateRestoreOptions(options)
}

func normalizeRestoreWords(options restoreOptions) (restoreOptions, error) {
	words := options.positionals
	if len(words) == 0 {
		return options, nil
	}
	switch words[0] {
	case "name":
		if len(words) != 2 {
			return restoreOptions{}, errors.New("use 'ompi control restore name NAME'")
		}
		options.name = true
	case "save":
		if len(words) != 2 {
			return restoreOptions{}, errors.New("use 'ompi control restore save NAME --instance ID'")
		}
	case "list", "history", "checkpoint", "export":
		if len(words) != 1 {
			return restoreOptions{}, fmt.Errorf("restore %s does not accept extra words", words[0])
		}
		switch words[0] {
		case "list":
			options.list = true
		case "history":
			options.history = true
		case "checkpoint":
			options.checkpoint = true
		case "export":
			options.export = true
		}
	case "import-legacy":
		options.importLegacy = true
		if len(words) > 2 {
			return restoreOptions{}, errors.New("use 'ompi control restore import-legacy [PATH]'")
		}
		if len(words) == 2 {
			options.importPath = words[1]
		}
		options.positionals = words[:1]
	case "slot", "from":
		if len(words) != 2 || protocol.ValidateInstanceID(words[1]) != nil {
			return restoreOptions{}, fmt.Errorf("use 'ompi control restore %s FULL_ID'", words[0])
		}
		if options.from != "" {
			return restoreOptions{}, errors.New("--from is only valid with list or export")
		}
		if words[0] == "slot" {
			options.slot = words[1]
		} else {
			options.from = words[1]
			options.fromOperation = true
		}
		options.positionals = words[:1]
	}
	return options, nil
}

func restoreOptionValue(args []string, index int, option string) (string, int, error) {
	if index+1 >= len(args) || strings.HasPrefix(args[index+1], "-") {
		return "", index, fmt.Errorf("%s requires a value", option)
	}
	if args[index+1] == "" && option != "--profile" {
		return "", index, fmt.Errorf("%s requires a value", option)
	}
	return args[index+1], index + 1, nil
}

func validateRestoreOptions(options restoreOptions) error {
	if options.help || options.version {
		return nil
	}
	if err := validateRecoveryOptions(options); err != nil {
		return err
	}
	if options.from != "" {
		if err := protocol.ValidateInstanceID(options.from); err != nil {
			return fmt.Errorf("invalid --from checkpoint: %w", err)
		}
	}
	if options.slot != "" {
		if err := protocol.ValidateInstanceID(options.slot); err != nil {
			return fmt.Errorf("invalid slot ID: %w", err)
		}
	}
	if options.name {
		return protocol.ValidateRestoreName(options.positionals[1])
	}
	if options.instance != "" {
		if len(options.positionals) != 2 || options.positionals[0] != "save" {
			return errors.New("--instance is only valid with 'save NAME'")
		}
		if err := protocol.ValidateRestoreName(options.positionals[1]); err != nil {
			return err
		}
		return protocol.ValidateInstanceID(options.instance)
	}
	if len(options.positionals) == 0 || options.list || options.history || options.checkpoint || options.export || options.importLegacy || options.slot != "" || options.from != "" {
		return nil
	}
	if options.positionals[0] == "save" {
		return errors.New("use 'ompi control restore save NAME --instance ID'")
	}
	if len(options.positionals) > 1 {
		return errors.New("restore accepts one saved name; use an operation word for recovery")
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
