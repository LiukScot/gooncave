//! The app lock of Settings → Extra. The library page asks over IPC; `AppLock.swift` keeps the
//! code and asks for Face ID. Only the requests below pass, with a code of digits.
// Tested on any host; only an iPhone build calls it.
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use serde_json::{json, Value};

const ACTIONS: [&str; 7] = [
    "state",
    "set",
    "check",
    "clear",
    "faceOn",
    "faceOff",
    "biometric",
];
const CODE_DIGITS: std::ops::RangeInclusive<usize> = 4..=12;

/// The request Swift receives, or why the page's request is refused.
fn request(action: &str, code: Option<&str>) -> Result<String, String> {
    if !ACTIONS.contains(&action) {
        return Err(format!("The lock does not know \"{action}\"."));
    }
    let needs_code = matches!(action, "set" | "check");
    match code {
        Some(code) if needs_code => {
            if !CODE_DIGITS.contains(&code.len()) || !code.bytes().all(|b| b.is_ascii_digit()) {
                return Err(format!(
                    "The code is {} to {} digits.",
                    CODE_DIGITS.start(),
                    CODE_DIGITS.end()
                ));
            }
            Ok(json!({ "action": action, "code": code }).to_string())
        }
        None if !needs_code => Ok(json!({ "action": action }).to_string()),
        _ if needs_code => Err("The lock needs the code.".into()),
        _ => Err("This lock request takes no code.".into()),
    }
}

#[tauri::command]
pub async fn app_lock(action: String, code: Option<String>) -> Result<Value, String> {
    let request = request(&action, code.as_deref())?;
    #[cfg(target_os = "ios")]
    {
        let answer = crate::photos::lock(&request).await?;
        let answer: Value = serde_json::from_str(&answer).map_err(|error| error.to_string())?;
        match answer["error"].as_str() {
            Some(error) => Err(error.to_owned()),
            None => Ok(answer),
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = request;
        Err("The lock needs the iPhone app.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::request;

    #[test]
    fn only_known_requests_with_a_code_of_digits_reach_the_keychain() {
        assert_eq!(request("state", None).unwrap(), r#"{"action":"state"}"#);
        assert_eq!(
            request("check", Some("123456")).unwrap(),
            r#"{"action":"check","code":"123456"}"#
        );
        assert!(request("check", None).is_err());
        assert!(request("set", Some("12a4")).is_err());
        assert!(request("set", Some("123")).is_err());
        assert!(request("set", Some("1234567890123")).is_err());
        assert!(request("clear", Some("1234")).is_err());
        assert_eq!(request("faceOn", None).unwrap(), r#"{"action":"faceOn"}"#);
        assert!(request("faceOff", Some("1234")).is_err());
        assert!(request("export", None).is_err());
    }
}
