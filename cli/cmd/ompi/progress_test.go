package main

import (
	"io"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/klondikemarlen/omp-instance-control/cli"
)

func TestTruncateTerminalTextKeepsUnicodeRunesIntact(t *testing.T) {
	truncated := truncateTerminalText("猫猫猫", 5)
	if truncated != "猫.." || len(truncated) > 5 || !utf8.ValidString(truncated) {
		t.Fatalf("truncateTerminalText() = %q; want a rune-safe five-byte result", truncated)
	}
}

func TestVisibleRestartRowsPutsPendingTargetsFirstWhenLimited(t *testing.T) {
	rows := []progressLine{
		{text: "finished", status: "restarted"},
		{text: "first-pending", status: "waiting"},
		{text: "failed", status: "failed"},
		{text: "second-pending", status: "restarting"},
	}

	visible, hidden := appendVisibleRestartRows(nil, rows, 2)
	if len(visible) != 2 || hidden != 2 {
		t.Fatalf("visible rows = %d, hidden = %d; want 2 visible and 2 hidden", len(visible), hidden)
	}
	if !strings.Contains(visible[0].text, "first-pending") || !strings.Contains(visible[1].text, "second-pending") {
		t.Fatalf("visible target order = [%q, %q]; want pending targets first", visible[0].text, visible[1].text)
	}
}

func TestRestartRendererRedirectedOutputIsTransitionOnly(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}

	renderer := newRestartRenderer(writer)
	rows := []cli.Row{{InstanceID: "target-12345", Status: "waiting"}}
	renderer.progress(rows)
	renderer.progress(rows)
	renderer.close()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}

	text := string(output)
	if strings.Contains(text, "\x1b[") {
		t.Fatalf("redirected output contains ANSI control sequences: %q", text)
	}
	if strings.Count(text, "target-12345") != 1 {
		t.Fatalf("redirected output repeated an unchanged target: %q", text)
	}
}
