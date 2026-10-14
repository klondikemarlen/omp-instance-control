package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/klondikemarlen/omp-instance-control/cli"
)

func runRestart(transport cli.Transport, all bool, instanceID string, jsonOutput, noWait bool, timeout time.Duration) (int, error) {
	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	var renderer *restartRenderer
	if !jsonOutput {
		renderer = newRestartRenderer(os.Stdout)
		fmt.Fprintln(os.Stdout, "Requesting restart...")
	}

	rows, err := cli.RestartInstances(transport, all, instanceID)
	if err != nil {
		return 1, err
	}

	if !noWait {
		if timeout > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, timeout)
			defer cancel()
		}

		var progress func([]cli.Row)
		if renderer != nil {
			progress = renderer.progress
		}
		rows, err = cli.WaitForRestarts(ctx, transport, rows, progress)
	} else if renderer != nil {
		renderer.progress(rows)
	}

	if renderer != nil {
		renderer.finish()
	}
	if jsonOutput && printRows(rows, true) != 0 && err == nil {
		return 1, nil
	}

	if errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "Restart observation stopped; accepted requests can still restart.")
		return 130, nil
	}
	if errors.Is(err, context.DeadlineExceeded) {
		fmt.Fprintln(os.Stderr, "Restart wait timed out; accepted requests can still restart.")
		return 1, nil
	}
	if err != nil {
		return 1, err
	}
	return restartExitCode(rows, !noWait), nil
}
