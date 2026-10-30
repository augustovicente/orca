#!/usr/bin/env python3
"""Temporary native-provider contrasts on disposable CI desktops."""
import argparse
import hashlib
import os
from pathlib import Path
import sys


def main():
    if (sys.platform not in ("linux", "win32") or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("ORCA_COMPUTER_BENCH_ISOLATED") != "1"
            or os.environ.get("ORCA_BACKGROUND_LAUNCH") != "1"):
        raise SystemExit("input probe requires isolated CI")
    sys.stdout.reconfigure(encoding="utf-8")
    import bench
    import trial_contract
    if sys.platform == "win32":
        import obs_win as obs
    else:
        import obs_x11 as obs
    bench.obs = obs
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--target", choices=("fixture", "electron"), required=True)
    parser.add_argument("--electron")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True)
    sources = args.out / "sources"
    evidence = {"sources": {}, "rows": []}
    engines = ("baseline", "bridge") if sys.platform == "win32" else ("baseline", "xdo0", "xdo12")
    for name in engines:
        evidence["sources"][name] = bench.pin_source(args.source, sources / name)
        if name == "bridge":
            path = sources / name / "native/computer-use-windows/runtime.ps1"
            text = path.read_text()
            text = text.replace('public static class OrcaDesktopWin32 {', 'public static class OrcaDesktopWin32 {\n    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]\n    public static void InitializeAutomation() {\n        System.Windows.Automation.ClientSettings.RegisterClientSideProviders(\n            new System.Windows.Automation.ClientSideProviderDescription[0]);\n    }')
            text = text.replace('Add-Type -TypeDefinition @"', 'Add-Type -ReferencedAssemblies @(\'System.dll\', [Windows.Automation.AutomationElement].Assembly.Location, [Windows.Automation.AutomationIdentifier].Assembly.Location) -TypeDefinition @"')
            text = text.replace('"@\n\n$MaxNodes', '"@\n\n[OrcaDesktopWin32]::InitializeAutomation()\n\n$MaxNodes')
            path.write_text(text)
            evidence["sources"][name]["modified_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        elif name.startswith("xdo"):
            path = sources / name / "native/computer-use-linux/runtime.py"
            text = path.read_text()
            original = 'def type_text(value):\n    Atspi.generate_keyboard_event(0, str(value), Atspi.KeySynthType.STRING)'
            replacement = 'def type_text(value):\n    xdotool = shutil.which("xdotool")\n    if not xdotool:\n        raise RuntimeError("xdotool is required")\n    subprocess.run([xdotool, "type", "--clearmodifiers", "--delay", DELAY, "--file", "-"],\n                   input=str(value), encoding="utf-8", env={**os.environ, "LC_ALL": "C.UTF-8"},\n                   check=True, capture_output=True, timeout=10)'.replace("DELAY", repr(name[3:]))
            if text.count(original) != 1:
                raise AssertionError("type_text source did not match")
            path.write_text(text.replace(original, replacement))
            evidence["sources"][name]["modified_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    markers = ["Orca café Ω"] if sys.platform == "win32" else ["Orca café Ω", "- café Ω 漢字 🙂 éΩéΩ"]
    tasks = ("targeted_type", "type_submit", "replace_submit", "click_interference") if sys.platform == "win32" else ("type_submit", "replace_submit")
    with (args.out / "engines.log").open("ab") as log:
        control = bench.Trial(args, args.out / "control", log)
        try:
            control.launch()
            evidence["calibration"] = control.calibrate()
        finally:
            control.close()
        for marker in markers:
            bench.MARKER = trial_contract.MARKER = marker
            for name in engines:
                for task in tasks:
                    profiles = ("background", "foreground") if sys.platform == "win32" and task == "targeted_type" else ("foreground",)
                    for profile in profiles:
                        for round in range(2):
                            cell = {"engine": name, "task": task, "profile": profile, "round": round}
                            trial = bench.Trial(args, args.out / f"trial-{len(evidence['rows']):03d}", log)
                            try:
                                row = trial.run(cell, sources)
                                row["marker"] = marker
                                evidence["rows"].append(row)
                            finally:
                                trial.close()
                            bench.write_json(args.out / "results.json", evidence)
                            state = row.get("final_state") or {}
                            print({**cell, "marker": marker, "verdict": row["verdict"],
                                   "text": state.get("text"), "submitted": state.get("submittedText"),
                                   "discovery_error": row.get("discovery_error"), "errors": row["api_errors"]}, flush=True)
    if any(row["verdict"] in ("invalid_setup", "unobserved") for row in evidence["rows"]):
        raise SystemExit("probe observation failed")


if __name__ == "__main__":
    main()
