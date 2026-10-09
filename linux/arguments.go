package linux

import (
	"fmt"
	"path/filepath"
	"strings"
)

// restartArguments mirrors OMP's public v18.8.7 flag tables. Unknown long
// flags followed by a value-like token are deliberately ambiguous: that token
// may be a string flag's value or the initial prompt, so neither is replayed.
func restartArguments(args []string, initialCwd string, flagTypes map[string]string) ([]string, string, string, error) {
	profile := ""
	cwd := initialCwd
	kept := make([]string, 0, len(args)+4)
	ambiguousFlag := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			continue
		}

		name, inlineValue, hasInline := splitFlag(arg)
		kind := flagValueKind(name)
		if flagTypes != nil && kind != valueUnknown {
			flagType := "boolean"
			if kind != valueBoolean {
				flagType = "string"
			}
			flagTypes[strings.TrimPrefix(name, "--")] = flagType
		}
		value, present := inlineValue, hasInline
		consumesNext := false
		if !hasInline && i+1 < len(args) {
			next := args[i+1]
			switch kind {
			case valueRequired:
				consumesNext = true
			case valueOptional, valuePlan:
				consumesNext = next != "" && !strings.HasPrefix(next, "-")
			case valueUnknown:
				if strings.HasPrefix(name, "--") && !strings.HasPrefix(next, "-") && ambiguousFlag == "" {
					ambiguousFlag = name
				}
			}
		}
		if consumesNext {
			value, present = args[i+1], true
			i++
		}
		if name == "--profile" && present {
			profile = value
		}
		if name == "--cwd" && present {
			cwd = absolutePath(initialCwd, value)
		}
		if isSessionSource(name) || name == "--goal" {
			continue
		}
		kept = append(kept, arg)
		if consumesNext {
			kept = append(kept, value)
		}
	}
	if ambiguousFlag != "" {
		return nil, profile, cwd, fmt.Errorf("RESTART_ARGUMENTS_UNAVAILABLE: %s may consume the startup prompt; use --custom=value for an extension string flag", ambiguousFlag)
	}
	for index := 0; index < len(kept); index++ {
		name, inlineValue, hasInline := splitFlag(kept[index])
		kind := flagValueKind(name)
		pathFlag := isPathFlag(name)
		base := cwd
		if name == "--cwd" {
			base = initialCwd
		}
		if hasInline {
			if pathFlag {
				kept[index] = name + "=" + absolutePath(base, inlineValue)
			}
			continue
		}
		if index+1 < len(kept) && (kind == valueRequired || kind == valueOptional || kind == valuePlan) {
			if kind == valueRequired || !strings.HasPrefix(kept[index+1], "-") {
				if pathFlag {
					kept[index+1] = absolutePath(base, kept[index+1])
				}
				index++
			}
		}
	}
	return kept, profile, cwd, nil
}

type valueKind int

const (
	valueUnknown valueKind = iota
	valueBoolean
	valueRequired
	valueOptional
	valuePlan
)

func splitFlag(arg string) (name, value string, hasValue bool) {
	if strings.HasPrefix(arg, "--") {
		if index := strings.IndexByte(arg, '='); index >= 0 {
			return arg[:index], arg[index+1:], true
		}
	}
	return arg, "", false
}

func flagValueKind(name string) valueKind {
	switch name {
	case "--profile", "--alias", "--cwd", "--config", "--add-dir", "--mode", "--fork", "--provider", "--model", "--smol", "--slow", "--goal", "--prewalk-into", "--plan-yolo-into", "--max-time", "--service-tier", "--api-key", "--system-prompt", "--system-prompt-template", "--append-system-prompt", "--provider-session-id", "--prompt-cache-key", "--session-dir", "--models", "--tools", "--thinking", "--export", "--hook", "--extension", "-e", "--trusted-extension", "--plugin-dir", "--skills", "--approval-mode":
		return valueRequired
	case "--plan":
		return valuePlan
	case "--resume", "-r", "--session":
		return valueOptional
	case "--help", "-h", "--version", "-v", "--allow-home", "--continue", "-c", "--from-claude", "--from-codex", "--no-session", "--no-tools", "--no-lsp", "--no-pty", "--hide-thinking", "--advisor", "--external-thinking", "--prewalk", "--no-prewalk", "--plan-yolo", "--print", "--print-thoughts", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--no-ui", "--auto-approve", "--yolo":
		return valueBoolean
	default:
		if strings.HasPrefix(name, "--") {
			return valueUnknown
		}
		return valueBoolean
	}
}

func isSessionSource(name string) bool {
	switch name {
	case "--resume", "-r", "--session", "--continue", "-c", "--fork", "--from-claude", "--from-codex":
		return true
	default:
		return false
	}
}

func isPathFlag(name string) bool {
	switch name {
	case "--cwd", "--config", "--add-dir", "--session-dir", "--extension", "-e", "--system-prompt-template", "--plugin-dir", "--hook", "--trusted-extension", "--export":
		return true
	default:
		return false
	}
}

func absolutePath(base, value string) string {
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return filepath.Clean(filepath.Join(base, value))
}
