package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/klondikemarlen/omp-instance-control/linux"
)

const recoverHelp = `Usage: ompi control recover FILE

After a failed restart, run the command printed in the affected terminal.
FILE is the private exact-restart recovery record, not a conversation or slot ID.
Recovery uses this terminal and the record's original profile/configuration scope.
It refuses changed or unavailable prerequisites and live or uncertain ownership.
It never retries automatically or selects a different conversation.
`

func runRecover(args []string) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Print(recoverHelp)
		return 0, nil
	}
	if len(args) != 1 || args[0] == "" || strings.HasPrefix(args[0], "-") {
		return 0, usageError("use 'ompi control recover FILE'; recovery takes exactly one private record path")
	}
	executable, err := os.Executable()
	if err != nil {
		return 1, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return 1, err
	}
	return linux.RecoverFailedRestart(args[0], resolveExtension(executable), version)
}
