package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/klondikemarlen/omp-instance-control/linux"
)

func printCleanupResults(results []linux.CleanupResult, jsonOutput bool) int {
	if jsonOutput {
		if err := json.NewEncoder(os.Stdout).Encode(results); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	} else if len(results) == 0 {
		fmt.Println("No registrations in this scope.")
	} else {
		for _, result := range results {
			fmt.Printf("%.12s %s %s\n", safeTerminalText(result.InstanceID), result.Status, safeTerminalText(result.Reason))
		}
	}
	for _, result := range results {
		if result.Status == "failed" {
			return 1
		}
	}
	return 0
}
