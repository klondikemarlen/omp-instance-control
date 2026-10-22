package main

import (
	"strings"
	"testing"
)

func TestParseRestartTargetRequiresExactlyOneValidTarget(t *testing.T) {
	instanceID := strings.Repeat("a", 32)
	for _, testCase := range []struct {
		name        string
		positionals []string
		wantAll     bool
		wantID      string
		wantError   bool
	}{
		{name: "all", positionals: []string{"all"}, wantAll: true},
		{name: "instance ID", positionals: []string{instanceID}, wantID: instanceID},
		{name: "missing", wantError: true},
		{name: "multiple", positionals: []string{"all", instanceID}, wantError: true},
		{name: "invalid ID", positionals: []string{"not-an-id"}, wantError: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			all, id, err := parseRestartTarget(testCase.positionals)
			if (err != nil) != testCase.wantError {
				t.Fatalf("parseRestartTarget() error = %v, want error %t", err, testCase.wantError)
			}
			if err == nil && (all != testCase.wantAll || id != testCase.wantID) {
				t.Fatalf("parseRestartTarget() = (%t, %q), want (%t, %q)", all, id, testCase.wantAll, testCase.wantID)
			}
		})
	}
}
