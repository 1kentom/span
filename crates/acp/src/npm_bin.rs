/// Follow npm exec's package bin inference instead of choosing an arbitrary map entry.
pub(crate) fn select_bin<'a>(
    package_name: &str,
    bin: &'a serde_json::Value,
) -> Result<&'a str, String> {
    match bin {
        serde_json::Value::String(path) if !path.is_empty() => Ok(path),
        serde_json::Value::Object(bins) if !bins.is_empty() => {
            let mut targets = bins.values().map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or("Invalid npm package executable")
            });
            let first = targets
                .next()
                .ok_or("Installed npm package has no executable")??;
            let remaining: Result<Vec<_>, _> = targets.collect();
            let remaining = remaining?;
            if remaining.iter().all(|target| *target == first) {
                return Ok(first);
            }
            let name = package_name
                .rsplit('/')
                .next()
                .ok_or("Invalid npm package name")?;
            bins.get(name).and_then(serde_json::Value::as_str).filter(|value| !value.is_empty())
                .ok_or_else(|| "This npm package has multiple executables and no unambiguous ACP entry. Use an explicit custom command.".into())
        }
        _ => Err("Installed npm package has no executable".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uses_npm_bin_inference_and_rejects_ambiguous_maps() {
        let multiple = serde_json::json!({"aaa-mcp":"mcp.js", "agent":"acp.js"});
        assert_eq!(select_bin("@vendor/agent", &multiple).unwrap(), "acp.js");
        let aliases = serde_json::json!({"one":"same.js", "two":"same.js"});
        assert_eq!(select_bin("agent", &aliases).unwrap(), "same.js");
        assert!(select_bin("different", &multiple)
            .unwrap_err()
            .contains("multiple executables"));
        assert!(select_bin("agent", &serde_json::json!({})).is_err());
    }
}
