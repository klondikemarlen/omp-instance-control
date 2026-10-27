package main

import (
	"bufio"
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

func validateRecoveryOptions(options restoreOptions) error {
	operations := 0
	for _, selected := range []bool{options.list, options.history, options.checkpoint, options.export, options.importLegacy} {
		if selected {
			operations++
		}
	}
	if operations > 1 {
		return errors.New("choose one recovery operation: --list, --history, --checkpoint, --export, or --import-legacy")
	}
	if options.json && !options.list && !options.history {
		return errors.New("--json is only valid with --list or --history")
	}
	if len(options.positionals) > 0 && (operations != 0 || options.from != "" || options.slot != "") {
		return errors.New("a saved name cannot be combined with recovery operation flags")
	}
	if options.instance != "" && (operations != 0 || options.from != "" || options.slot != "") {
		return errors.New("--instance is only valid with 'save NAME'")
	}
	if options.from != "" {
		if err := protocol.ValidateInstanceID(options.from); err != nil {
			return fmt.Errorf("invalid --from checkpoint: %w", err)
		}
		if options.history || options.checkpoint || options.importLegacy || options.slot != "" {
			return errors.New("--from is only valid when choosing, listing, or exporting checkpoint members")
		}
	}
	if options.slot != "" {
		if err := protocol.ValidateInstanceID(options.slot); err != nil {
			return fmt.Errorf("invalid --slot: %w", err)
		}
		if operations != 0 {
			return errors.New("--slot selects one managed session and cannot be combined with a recovery operation")
		}
	}
	return nil
}

func runRecovery(scope protocol.Scope, options restoreOptions) (int, error) {
	if options.checkpoint {
		checkpoint, err := linux.CaptureRecoveryCheckpoint(scope, "manual", "")
		if err != nil {
			return 1, err
		}
		fmt.Printf("Saved checkpoint %s (%d managed sessions).\n", checkpoint.CheckpointID, len(checkpoint.Entries))
		return 0, nil
	}
	if options.importLegacy {
		checkpoints, err := linux.ImportLegacyRecovery(scope, options.importPath)
		if err != nil {
			return 1, err
		}
		for _, checkpoint := range checkpoints {
			fmt.Printf("Imported legacy checkpoint %s (%d entries; review/export only).\n", checkpoint.CheckpointID, len(checkpoint.Legacy))
			printCheckpointWarnings(checkpoint)
			for index, entry := range checkpoint.Legacy {
				if entry.Unavailable != "" {
					printRecoverySession(os.Stdout, index, protocol.RecoverySession{Legacy: &entry})
				}
			}
		}
		if len(checkpoints) == 0 {
			fmt.Println("No new legacy recovery checkpoints were imported.")
		}
		return 0, nil
	}
	if options.history {
		checkpoints, err := linux.ListRecoveryCheckpoints(scope)
		if err != nil {
			return 1, err
		}
		return printRecoveryCheckpoints(checkpoints, options.json)
	}
	if options.slot != "" {
		snapshot, err := linux.SavedSessionForRestoreID(scope, options.slot)
		if err != nil {
			return 1, err
		}
		return confirmAndRestoreSlot(scope, protocol.RecoverySession{RestoreID: options.slot, Session: &snapshot})
	}

	sessions, err := linux.ListRecoverySessions(scope, options.from)
	if err != nil {
		return 1, err
	}
	if options.list {
		return printRecoverySessions(sessions, options.json)
	}
	if options.export {
		commands, err := linux.ExportRecoveryCommands(scope, sessions)
		if err != nil {
			return 1, err
		}
		fmt.Print(commands)
		return 0, nil
	}
	if options.from != "" {
		checkpoints, err := linux.ListRecoveryCheckpoints(scope)
		if err != nil {
			return 1, err
		}
		for _, checkpoint := range checkpoints {
			if checkpoint.CheckpointID == options.from && checkpoint.Reason == "legacy" {
				fmt.Println("Legacy recovery is review/export only; managed process ownership was not recorded.")
				printCheckpointWarnings(checkpoint)
				commands, err := linux.ExportRecoveryCommands(scope, sessions)
				if err != nil {
					return 1, err
				}
				fmt.Print(commands)
				return 0, nil
			}
		}
	}
	if len(sessions) == 0 {
		return 1, errors.New("no recoverable managed sessions in this scope; history is available with 'ompi control restore --history'")
	}
	if !hasRestoreTerminal(os.Stdin) || !hasRestoreTerminal(os.Stdout) {
		return 1, errors.New("interactive recovery requires a terminal; use --list, --export, a saved name, or --slot ID")
	}
	selected, confirmed, err := chooseRecoverySession(bufio.NewReader(os.Stdin), os.Stdout, sessions)
	if err != nil {
		return 1, err
	}
	if !confirmed {
		fmt.Println("Restore cancelled.")
		return 0, nil
	}
	return launchRecoverySlot(scope, selected)
}

func recoverySessionLabel(session protocol.RecoverySession) string {
	if session.Name != "" {
		return session.Name
	}
	if session.RestoreID != "" {
		return "slot " + session.RestoreID
	}
	return "legacy session"
}

func printRecoverySessions(sessions []protocol.RecoverySession, jsonOutput bool) (int, error) {
	if jsonOutput {
		if sessions == nil {
			sessions = []protocol.RecoverySession{}
		}
		if err := json.NewEncoder(os.Stdout).Encode(sessions); err != nil {
			return 1, err
		}
		return 0, nil
	}
	if len(sessions) == 0 {
		fmt.Println("No recovery sessions in this scope.")
	}
	for index, session := range sessions {
		printRecoverySession(os.Stdout, index, session)
	}
	return 0, nil
}

func printRecoverySession(output io.Writer, index int, session protocol.RecoverySession) {
	name := session.Name
	if name == "" {
		name = "-"
	}
	slot := session.RestoreID
	if slot == "" {
		slot = "-"
	}
	if session.Legacy != nil {
		legacy := session.Legacy
		if legacy.Unavailable != "" {
			fmt.Fprintf(output, "%d) legacy %s unavailable: %s\n", index+1, safeTerminalText(legacy.SessionID), safeTerminalText(legacy.Unavailable))
			return
		}
		fmt.Fprintf(output, "%d) legacy %s %s (review/export only)\n", index+1, safeTerminalText(legacy.SessionID), safeTerminalText(legacy.CWD))
		return
	}
	if session.Unavailable != "" {
		fmt.Fprintf(output, "%d) %s %s unavailable: %s\n", index+1, safeTerminalText(name), slot, safeTerminalText(session.Unavailable))
		return
	}
	if session.Session == nil {
		fmt.Fprintf(output, "%d) %s %s unavailable: no managed session snapshot\n", index+1, safeTerminalText(name), slot)
		return
	}
	fmt.Fprintf(output, "%d) %s %s %s %s\n", index+1, safeTerminalText(name), slot, safeTerminalText(session.Session.SessionID), safeTerminalText(session.Session.CWD))
}

func printRecoveryCheckpoints(checkpoints []protocol.RecoveryCheckpoint, jsonOutput bool) (int, error) {
	if jsonOutput {
		if checkpoints == nil {
			checkpoints = []protocol.RecoveryCheckpoint{}
		}
		if err := json.NewEncoder(os.Stdout).Encode(checkpoints); err != nil {
			return 1, err
		}
		return 0, nil
	}
	if len(checkpoints) == 0 {
		fmt.Println("No recovery checkpoints in this scope.")
	}
	for index, checkpoint := range checkpoints {
		fmt.Printf("%d) %s %s %s (%d managed, %d legacy)\n", index+1, checkpoint.CheckpointID, checkpoint.Reason, safeTerminalText(checkpoint.CreatedAt), len(checkpoint.Entries), len(checkpoint.Legacy))
		printCheckpointWarnings(checkpoint)
	}
	return 0, nil
}

func printCheckpointWarnings(checkpoint protocol.RecoveryCheckpoint) {
	for _, warning := range checkpoint.Warnings {
		fmt.Printf("Warning: %s\n", safeTerminalText(warning))
	}
}

func requireRecoveryAvailable(session protocol.RecoverySession) error {
	if session.Unavailable != "" {
		return fmt.Errorf("recovery session %q is unavailable: %s", safeTerminalText(recoverySessionLabel(session)), safeTerminalText(session.Unavailable))
	}
	if session.Legacy != nil || session.RestoreID == "" || session.Session == nil || session.Session.SessionID == "" {
		return errors.New("legacy recovery has no verified managed-slot ownership; review its portable export instead")
	}
	return nil
}

func chooseRecoverySession(input io.Reader, output io.Writer, sessions []protocol.RecoverySession) (protocol.RecoverySession, bool, error) {
	reader := bufio.NewReader(input)
	for {
		for index, session := range sessions {
			printRecoverySession(output, index, session)
		}
		fmt.Fprint(output, "Choose a recovery session number, or q to cancel: ")
		line, err := reader.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return protocol.RecoverySession{}, false, err
		}
		choice := strings.TrimSpace(line)
		if choice == "" || strings.EqualFold(choice, "q") {
			return protocol.RecoverySession{}, false, nil
		}
		index, parseErr := strconv.Atoi(choice)
		if parseErr != nil || index < 1 || index > len(sessions) {
			if errors.Is(err, io.EOF) {
				return protocol.RecoverySession{}, false, nil
			}
			fmt.Fprintln(output, "Enter a listed number or q to cancel.")
			continue
		}
		selected := sessions[index-1]
		if err := requireRecoveryAvailable(selected); err != nil {
			return protocol.RecoverySession{}, false, err
		}
		confirmed, confirmErr := confirmNamedRestore(reader, output, protocol.NamedSession{Name: recoverySessionLabel(selected), Session: *selected.Session})
		return selected, confirmed, confirmErr
	}
}

func confirmAndRestoreSlot(scope protocol.Scope, selected protocol.RecoverySession) (int, error) {
	if err := requireRecoveryAvailable(selected); err != nil {
		return 1, err
	}
	confirmed, err := confirmNamedRestore(os.Stdin, os.Stdout, protocol.NamedSession{Name: recoverySessionLabel(selected), Session: *selected.Session})
	if err != nil {
		return 1, err
	}
	if !confirmed {
		fmt.Println("Restore cancelled.")
		return 0, nil
	}
	return launchRecoverySlot(scope, selected)
}

func launchRecoverySlot(scope protocol.Scope, selected protocol.RecoverySession) (int, error) {
	executable, err := os.Executable()
	if err != nil {
		return 1, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return 1, err
	}
	return linux.RestoreSessionSlot(scope, selected.RestoreID, resolveExtension(executable), version, *selected.Session)
}
