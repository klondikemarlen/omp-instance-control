package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/klondikemarlen/omp-instance-control/cli"
)

func runRestart(transport cli.Transport, all bool, instanceID string, jsonOutput, noWait bool) (int, error) {
	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	var renderer *restartRenderer
	if !jsonOutput {
		renderer = newRestartRenderer(os.Stdout)
		defer renderer.close()
		fmt.Fprintln(os.Stdout, "Requesting restart...")
	}

	rows, err := cli.RestartInstances(transport, all, instanceID)
	if err != nil {
		if renderer != nil {
			renderer.showOutcome(nil, "Restart request failed: "+safeTerminalText(err.Error()))
		}
		return 1, err
	}

	if renderer != nil {
		renderer.progress(rows)
	}
	if noWait {
		if renderer != nil {
			renderer.showOutcome(rows, "Completion observation skipped; accepted requests may still restart.")
		}
	} else {
		var progress func([]cli.Row)
		if renderer != nil {
			renderer.startAnimation()
			progress = renderer.progress
		}
		rows, err = cli.WaitForRestarts(ctx, transport, rows, progress)
		if renderer != nil {
			switch {
			case errors.Is(err, context.Canceled):
				renderer.showOutcome(rows, "Observation stopped; accepted requests can still restart.")
			case err != nil:
				renderer.showOutcome(rows, "Observation failed: "+safeTerminalText(err.Error()))
			default:
				renderer.showOutcome(rows, "Restart observation complete.")
			}
		}
	}

	if jsonOutput && printRows(rows, true) != 0 && err == nil {
		return 1, nil
	}

	if errors.Is(err, context.Canceled) {
		if renderer != nil {
			renderer.close()
		}
		fmt.Fprintln(os.Stderr, "Restart observation stopped; accepted requests can still restart.")
		return 130, nil
	}
	if err != nil {
		return 1, err
	}
	return restartExitCode(rows, !noWait), nil
}
