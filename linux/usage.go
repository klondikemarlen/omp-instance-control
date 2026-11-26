package linux

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

// Counter names are a fixed storage contract shared with linux/usage.js.
var usageFeatures = [...]string{
	"list",
	"restart",
	"send",
	"steer",
	"cleanup",
	"recover",
	"take-over",
	"work.list",
	"work.find",
	"work.resume",
	"work.set",
	"work.clear",
	"restore.select",
	"restore.save",
	"restore.name",
	"restore.slot",
	"restore.list",
	"restore.checkpoint",
	"restore.history",
	"restore.from",
	"restore.export",
}

// UsageCount is the aggregate for one surface and fixed feature.
type UsageCount struct {
	Surface string `json:"surface"`
	Feature string `json:"feature"`
	Count   int64  `json:"count"`
}

// AppendCLIUsage appends one event for a fixed CLI feature without affecting dispatch.
func AppendCLIUsage(scope protocol.Scope, feature string) {
	if !slices.Contains(usageFeatures[:], feature) {
		return
	}

	dir, err := openUsageDirectory(scope, true)
	if err != nil {
		return
	}
	defer syscall.Close(dir)

	file, _, err := openUsageCounter(dir, "cli."+feature, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_APPEND)
	if err != nil {
		return
	}
	defer syscall.Close(file)

	var event [1]byte
	for {
		if _, err := syscall.Write(file, event[:]); !errors.Is(err, syscall.EINTR) {
			return
		}
	}
}

// ReadUsage reports nonzero counts from both surfaces without creating storage.
func ReadUsage(scope protocol.Scope) ([]UsageCount, error) {
	counts := []UsageCount{}
	dir, err := openUsageDirectory(scope, false)
	if errors.Is(err, syscall.ENOENT) {
		return counts, nil
	}
	if err != nil {
		return nil, err
	}
	defer syscall.Close(dir)

	for _, surface := range [...]string{"cli", "slash"} {
		for _, feature := range usageFeatures {
			file, size, err := openUsageCounter(dir, surface+"."+feature, syscall.O_RDONLY)
			if errors.Is(err, syscall.ENOENT) {
				continue
			}
			if err != nil {
				return nil, err
			}
			_ = syscall.Close(file)
			if size > 0 {
				counts = append(counts, UsageCount{
					Surface: surface,
					Feature: feature,
					Count:   size,
				})
			}
		}
	}
	return counts, nil
}

func openUsageDirectory(scope protocol.Scope, create bool) (int, error) {
	if !filepath.IsAbs(scope.AgentDir) || filepath.Clean(scope.AgentDir) != scope.AgentDir {
		return -1, errors.New("invalid usage agent directory")
	}

	controlDir := filepath.Join(scope.AgentDir, "instance-control")
	usageDir := filepath.Join(controlDir, "usage-v1")
	const flags = syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	dir, err := syscall.Open("/", flags, 0)
	if err != nil {
		return -1, err
	}

	// Keep each parent descriptor pinned while opening the next path component.
	pathEnd := 0
	for component := range strings.SplitSeq(strings.TrimPrefix(usageDir, "/"), "/") {
		pathEnd += 1 + len(component)
		current := usageDir[:pathEnd]
		child, err := syscall.Openat(dir, component, flags, 0)
		if create && errors.Is(err, syscall.ENOENT) {
			err = syscall.Mkdirat(dir, component, 0o700)
			if err == nil || errors.Is(err, syscall.EEXIST) {
				child, err = syscall.Openat(dir, component, flags, 0)
			}
		}
		_ = syscall.Close(dir)
		if err == syscall.ENOENT {
			return -1, err
		}
		if err != nil {
			return -1, fmt.Errorf("open usage directory %q: %w", current, err)
		}
		if err := validateUsageDirectory(child, current, controlDir, usageDir); err != nil {
			_ = syscall.Close(child)
			return -1, err
		}
		dir = child
	}
	return dir, nil
}

func validateUsageDirectory(fd int, path, controlDir, usageDir string) error {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return err
	}

	if !isTrustedDirectoryAncestor(path, stat.Uid, stat.Mode&0o022 != 0, stat.Mode&syscall.S_ISVTX != 0) {
		return fmt.Errorf("unsafe usage directory %q", path)
	}
	if (path == controlDir || path == usageDir) && stat.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("usage directory %q is not owned by the current user", path)
	}
	if path == usageDir && stat.Mode&0o077 != 0 {
		return fmt.Errorf("usage directory %q is not private to the current user", path)
	}
	return nil
}

func openUsageCounter(dir int, name string, flags int) (int, int64, error) {
	file, err := syscall.Openat(dir, name, flags|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0o600)
	if err == syscall.ENOENT {
		return -1, 0, err
	}
	if err != nil {
		return -1, 0, fmt.Errorf("open usage counter %q: %w", name, err)
	}

	var stat syscall.Stat_t
	if err := syscall.Fstat(file, &stat); err != nil {
		_ = syscall.Close(file)
		return -1, 0, fmt.Errorf("inspect usage counter %q: %w", name, err)
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Mode&0o077 != 0 || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 {
		_ = syscall.Close(file)
		return -1, 0, fmt.Errorf("usage counter %q is not a private regular file with one link", name)
	}
	return file, stat.Size, nil
}
