package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/klondikemarlen/omp-instance-control/linux"
	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const resumeHelp = `Usage: ompi control resume PR_URL [--profile NAME]

Open the original GitHub pull request conversation in this terminal and directory.
In OMP, submit the prepared slash command, then review and confirm the resume.
An interactive terminal is required.
Live or uncertain targets are refused; no conversation is forked.
`

func runResume(args []string) (int, error) {
	optionArgs, positionals := splitControlArguments(args)
	flags := flag.NewFlagSet("ompi control resume", flag.ContinueOnError)
	profile := flags.String("profile", "", "OMP profile")
	help := flags.Bool("help", false, "show command help")
	flags.BoolVar(help, "h", false, "show command help")
	if err := flags.Parse(optionArgs); err != nil {
		return 0, usageError(err.Error())
	}
	if *help {
		fmt.Print(resumeHelp)
		return 0, nil
	}
	if len(positionals) != 1 {
		return 0, usageError("use 'ompi control resume PR_URL'; exactly one GitHub pull request URL is required")
	}
	url, err := protocol.NormalizeWorkURL(positionals[0])
	if err != nil || !strings.HasSuffix(url[:strings.LastIndexByte(url, '/')], "/pull") {
		return 0, usageError("PR_URL must be https://github.com/OWNER/REPO/pull/N")
	}

	recordCLIUsage("work.resume", protocol.Scope{}, *profile)
	executable, err := os.Executable()
	if err != nil {
		return 1, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return 1, err
	}
	return linux.LaunchPullRequest(url, *profile, resolveExtension(executable), version)
}
