package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/klondikemarlen/omp-instance-control/cli"
	"github.com/klondikemarlen/omp-instance-control/linux"
	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const workHelp = `Usage: ompi control work COMMAND [OPTIONS]
  ompi control work list [--profile NAME] [--json]
  ompi control work find [--profile NAME] [--json] URL
  ompi control work set [--profile NAME] [--json] [--branch NAME] ID URL SUMMARY
  ompi control work clear [--profile NAME] [--json] ID

Options precede positional arguments. Quote SUMMARY as one literal shell argument.
URL is https://github.com/OWNER/REPO/issues/N or https://github.com/OWNER/REPO/pull/N.
ID must uniquely identify a current live instance by lowercase hexadecimal prefix.
Set and clear update the selected instance's saved conversation; they do not send messages.
List and find show all claims or matches, including offline and conflicting claims.
A claim is marked stale more than 24 hours after it was set; it is not deleted.
`

type workOptions struct {
	action            string
	profile           string
	json              bool
	help              bool
	instanceID        string
	url               string
	summary           string
	branch            string
	expectSessionID   string
	expectSessionFile string
}

func runWork(output io.Writer, args []string) (int, error) {
	options, err := parseWorkOptions(args)
	if err != nil {
		return 0, err
	}
	if options.help {
		_, err := fmt.Fprint(output, workHelp)
		return 0, err
	}

	scope, err := protocol.GetScope(options.profile, "")
	if err != nil {
		return 1, err
	}
	transport, err := linux.NewTransport(scope)
	if err != nil {
		return 1, err
	}
	rows, err := cli.ListInstances(transport)
	if err != nil {
		return 1, err
	}

	if options.action == "list" || options.action == "find" {
		err = listWorkClaims(output, scope, options, rows)
	} else {
		err = updateWorkClaim(output, scope, options, rows)
	}
	if err != nil {
		return 1, err
	}
	return 0, nil
}

func parseWorkOptions(args []string) (workOptions, error) {
	var options workOptions
	if len(args) == 0 || (len(args) == 1 && (args[0] == "help" || args[0] == "--help" || args[0] == "-h")) {
		options.help = true
		return options, nil
	}

	options.action = args[0]
	var expectedArguments int
	switch options.action {
	case "list":
		// No positional arguments.
	case "find", "clear":
		expectedArguments = 1
	case "set":
		expectedArguments = 3
	default:
		return options, usageError("use 'ompi control work --help' for available commands")
	}

	flags := flag.NewFlagSet("ompi control work "+options.action, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&options.profile, "profile", "", "OMP profile")
	flags.BoolVar(&options.json, "json", false, "JSON output")
	flags.BoolVar(&options.help, "help", false, "show command help")
	flags.BoolVar(&options.help, "h", false, "show command help")
	if options.action == "set" {
		flags.StringVar(&options.branch, "branch", "", "worktree branch")
	}
	if options.action == "set" || options.action == "clear" {
		// The slash command supplies its own conversation identity to guard against a session switch.
		flags.StringVar(&options.expectSessionID, "expect-session-id", "", "expected session ID")
		flags.StringVar(&options.expectSessionFile, "expect-session-file", "", "expected session file")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return options, usageError(err.Error())
	}
	if options.help {
		return options, nil
	}
	if flags.NArg() != expectedArguments {
		return options, usageError("invalid arguments; see 'ompi control work --help'")
	}

	if options.action == "set" || options.action == "clear" {
		options.instanceID = flags.Arg(0)
		if len(options.instanceID) == 0 || len(options.instanceID) > 32 || strings.Trim(options.instanceID, "0123456789abcdef") != "" {
			return options, usageError("invalid work target: use 1-32 lowercase hexadecimal characters")
		}
		if err := validateWorkSessionGuard(flags, options); err != nil {
			return options, err
		}
	}

	var url string
	switch options.action {
	case "find":
		url = flags.Arg(0)
	case "set":
		url = flags.Arg(1)
		options.summary = flags.Arg(2)
		if strings.TrimSpace(options.summary) == "" {
			return options, usageError("work summary must not be empty")
		}
	}
	if options.action == "find" || options.action == "set" {
		canonicalURL, err := protocol.NormalizeWorkURL(url)
		if err != nil {
			return options, usageError(err.Error())
		}
		options.url = canonicalURL
	}
	return options, nil
}

func validateWorkSessionGuard(flags *flag.FlagSet, options workOptions) error {
	guarded := false
	flags.Visit(func(option *flag.Flag) {
		if option.Name == "expect-session-id" || option.Name == "expect-session-file" {
			guarded = true
		}
	})
	if !guarded {
		return nil
	}

	if strings.TrimSpace(options.expectSessionID) == "" || !filepath.IsAbs(options.expectSessionFile) {
		return usageError("guarded work mutations require the expected session ID and absolute session file")
	}
	if err := protocol.ValidateInstanceID(options.instanceID); err != nil {
		return usageError("guarded work mutations require the complete launch ID")
	}
	return nil
}

func listWorkClaims(output io.Writer, scope protocol.Scope, options workOptions, rows []cli.Row) error {
	claims, err := linux.ReadWorkClaims(scope)
	if err != nil {
		return err
	}
	workRows := cli.WorkDirectory(claims, rows, options.url, time.Now())
	if options.json {
		return json.NewEncoder(output).Encode(workRows)
	}

	if len(workRows) == 0 {
		if options.action == "find" {
			_, err := fmt.Fprintf(output, "No work claims for %s in this scope.\n", options.url)
			return err
		}
		_, err := fmt.Fprintln(output, "No work claims in this scope.")
		return err
	}

	for _, row := range workRows {
		if err := printWorkRow(output, row); err != nil {
			return err
		}
	}
	return nil
}

func printWorkRow(output io.Writer, row cli.WorkRow) error {
	status := row.Availability
	if row.Stale {
		status += ", stale"
	}
	if row.Conflict {
		status += ", conflict"
	}
	instances := "none"
	if len(row.InstanceIDs) > 0 {
		instances = strings.Join(row.InstanceIDs, ", ")
	}
	if _, err := fmt.Fprintf(output, "%s  [%s]  %q\n  Live instances: %s; updated: %s\n  Session: %q (%q)\n  Worktree: %q\n",
		row.URL, status, row.Summary, instances, row.UpdatedAt, row.SessionID, row.SessionFile, row.CWD); err != nil {
		return err
	}
	if row.Branch != "" {
		_, err := fmt.Fprintf(output, "  Branch: %q\n", row.Branch)
		return err
	}
	return nil
}

func updateWorkClaim(output io.Writer, scope protocol.Scope, options workOptions, rows []cli.Row) error {
	session, err := cli.ResolveWorkSession(rows, options.instanceID)
	if err != nil {
		return err
	}
	if session.Scope != scope.ID {
		return fmt.Errorf("work target is not in the selected scope")
	}

	sessionFile := *session.SessionFile
	if options.expectSessionID != "" && (session.SessionID != options.expectSessionID || sessionFile != options.expectSessionFile) {
		return fmt.Errorf("work target is no longer the invoking saved conversation; run /ompi work again")
	}

	if options.action == "clear" {
		if err := linux.ClearWorkClaim(scope, session.SessionID, sessionFile); err != nil {
			return err
		}
		if options.json {
			return json.NewEncoder(output).Encode(map[string]string{
				"status":      "cleared",
				"sessionId":   session.SessionID,
				"sessionFile": sessionFile,
			})
		}
		_, err := fmt.Fprintf(output, "Work claim cleared for session %q.\n", session.SessionID)
		return err
	}

	claim := protocol.WorkClaim{
		Version:     protocol.WorkClaimVersion,
		Scope:       scope.ID,
		SessionID:   session.SessionID,
		SessionFile: sessionFile,
		CWD:         session.CWD,
		URL:         options.url,
		Summary:     options.summary,
		Branch:      options.branch,
		UpdatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := linux.WriteWorkClaim(scope, claim); err != nil {
		return err
	}
	if options.json {
		return json.NewEncoder(output).Encode(claim)
	}
	_, err = fmt.Fprintf(output, "Work claim set for session %q: %s\n", session.SessionID, claim.URL)
	return err
}
