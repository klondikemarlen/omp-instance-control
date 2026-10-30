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
		var removed, retained, failed int
		for _, result := range results {
			switch result.Status {
			case "removed":
				removed++
			case "preserved":
				retained++
			case "failed":
				failed++
			}
		}
		fmt.Printf("Cleanup: %d removed, %d retained, %d failed.\n", removed, retained, failed)
		for _, result := range results {
			if result.Status != "preserved" {
				fmt.Printf("%.12s %s %s\n", safeTerminalText(result.InstanceID), result.Status, safeTerminalText(result.Reason))
			}
		}
		if retained > 0 {
			fmt.Println("Retained registrations have live or uncertain owners; --json shows safety reasons. Cleanup does not stop terminals or cancel restarts.")
		}
	}
	for _, result := range results {
		if result.Status == "failed" {
			return 1
		}
	}
	return 0
}
