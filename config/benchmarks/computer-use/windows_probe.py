#!/usr/bin/env python3
"""Compare isolated Windows UIA registration and Unicode delivery experiments."""
import argparse
import hashlib
import os
from pathlib import Path
import sys


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("experiment source anchor is missing or ambiguous")
    return source.replace(old, new)


def main():
    if (sys.platform != "win32" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("ORCA_COMPUTER_BENCH_ISOLATED") != "1"
            or os.environ.get("ORCA_BACKGROUND_LAUNCH") != "1"):
        raise SystemExit("Windows probe requires isolated Windows CI")
    import bench
    import obs_win as obs
    bench.obs = obs
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--electron", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True)
    sources = args.out / "sources"
    pinned = bench.pin_source(args.source, sources / "baseline")
    relative = "native/computer-use-windows/runtime.ps1"
    baseline = (sources / "baseline" / relative).read_text(encoding="utf-8")
    proxy_registration = '''
$proxyName = [System.Reflection.AssemblyName]::new([Windows.Automation.AutomationElement].Assembly.FullName)
$proxyName.Name = "UIAutomationClientsideProviders"
[Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly($proxyName)
'''
    variants = {
        "baseline": baseline,
        "explicit_proxies": replace_once(baseline, "Add-Type -AssemblyName UIAutomationTypes",
                                         "Add-Type -AssemblyName UIAutomationTypes\n" + proxy_registration),
        "unicode_message": replace_once(baseline,
            '[DllImport("user32.dll")]\n    public static extern bool PostMessage',
            '[DllImport("user32.dll", EntryPoint = "PostMessageW")]\n    public static extern bool PostMessage'),
    }
    evidence = {"source": pinned, "experiments": {}, "rows": [], "complete": False}
    for name, source in variants.items():
        destination = sources / name / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.encode("utf-8"))
        evidence["experiments"][name] = {"sha256": hashlib.sha256(source.encode()).hexdigest()}
    try:
        with (args.out / "engines.log").open("ab") as log:
            for target in ("fixture", "electron"):
                args.target = target
                control = bench.Trial(args, args.out / f"controls-{target}", log)
                try:
                    control.launch()
                    evidence[f"calibration-{target}"] = control.calibrate()
                finally:
                    control.close()
                for name in variants:
                    for task in ("type_submit", "choose_and_click"):
                        cell = {"engine": name, "task": task, "profile": "foreground", "round": 0}
                        trial = bench.Trial(args, args.out / f"{target}-{name}-{task}", log)
                        try:
                            evidence["rows"].append({"target": target, **trial.run(cell, sources)})
                        finally:
                            trial.close()
                        bench.write_json(args.out / "results.json", evidence)
        evidence["complete"] = len(evidence["rows"]) == 12 and all(
            row["prepared"] and row["verdict"] != "unobserved" and not row.get("observer_error")
            and not row.get("terminal_observation_error") for row in evidence["rows"])
    except Exception as error:
        evidence["fatal"] = repr(error)
        raise
    finally:
        bench.write_json(args.out / "results.json", evidence)
    return 0 if evidence["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
