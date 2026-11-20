package protocol

import (
	"strings"
	"testing"
)

func TestNormalizeWorkURL(t *testing.T) {
	for _, test := range []struct {
		input string
		want  string
	}{
		{
			input: "https://github.com/Case-Owner/CaSe_REPO/issues/93",
			want:  "https://github.com/case-owner/case_repo/issues/93",
		},
		{
			input: "https://github.com/OWNER/.GitHub/pull/1",
			want:  "https://github.com/owner/.github/pull/1",
		},
	} {
		got, err := NormalizeWorkURL(test.input)
		if err != nil || got != test.want {
			t.Errorf("NormalizeWorkURL(%q) = %q, %v; want %q", test.input, got, err, test.want)
		}
	}
}

func TestNormalizeWorkURLRejectsExtraSyntax(t *testing.T) {
	for _, input := range []string{
		"http://github.com/owner/repo/issues/1",
		"https://github.com.evil.test/owner/repo/issues/1",
		"https://github.com@evil.test/owner/repo/issues/1",
		"https://user@github.com/owner/repo/issues/1",
		"https://github.com:443/owner/repo/issues/1",
		"https://github.com/owner/repo/discussions/1",
		"https://github.com/owner/../issues/1",
		"https://github.com/own%65r/repo/issues/1",
		"https://github.com/owner/repo/issues/1/",
		"https://github.com/owner/repo/issues/1?",
		"https://github.com/owner/repo/issues/1#comment",
		"https://github.com/owner/repo/issues/01",
		"https://github.com/owner/repo/issues/0",
		"https://github.com/owner/repo/pull/-4",
		"https://github.com/owner/repo/pull/18446744073709551616",
		" https://github.com/owner/repo/issues/1",
		"https://github.com/owner/repo/issues/1\n",
		"https://github.com/owner/" + strings.Repeat("r", 101) + "/issues/1",
	} {
		if got, err := NormalizeWorkURL(input); got != "" || err == nil {
			t.Errorf("NormalizeWorkURL(%q) = %q, %v; want rejection", input, got, err)
		}
	}
}
