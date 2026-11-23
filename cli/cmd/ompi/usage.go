package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/klondikemarlen/omp-instance-control/linux"
	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const usageHelp = "Usage: ompi control usage [--json]"

func recordCLIUsage(feature string, targetScope protocol.Scope, targetProfile string) {
	if os.Getenv("OMPI_USAGE") != "1" {
		return
	}

	invokingScope := targetScope
	if targetProfile != "" || invokingScope.AgentDir == "" {
		var err error
		invokingScope, err = protocol.GetScope("", "")
		if err != nil {
			return
		}
	}
	linux.AppendCLIUsage(invokingScope, feature)
}

func runUsage(output io.Writer, args []string) (int, error) {
	jsonOutput := false
	if len(args) > 1 {
		return 0, usageError("use 'ompi control usage [--json]'")
	}
	if len(args) == 1 {
		switch args[0] {
		case "--json":
			jsonOutput = true
		case "--help", "-h":
			_, err := fmt.Fprintln(output, usageHelp)
			return 0, err
		default:
			return 0, usageError("use 'ompi control usage [--json]'")
		}
	}

	scope, err := protocol.GetScope("", "")
	if err != nil {
		return 1, err
	}
	counts, err := linux.ReadUsage(scope)
	if err != nil {
		return 1, err
	}

	if jsonOutput {
		return 0, json.NewEncoder(output).Encode(counts)
	}
	if len(counts) == 0 {
		_, err := fmt.Fprintln(output, "No feature usage recorded. Set OMPI_USAGE=1 to opt in.")
		return 0, err
	}
	for _, row := range counts {
		if _, err := fmt.Fprintf(output, "%s\t%s\t%d\n", row.Surface, row.Feature, row.Count); err != nil {
			return 1, err
		}
	}
	return 0, nil
}
