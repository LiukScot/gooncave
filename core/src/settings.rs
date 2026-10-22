use rusqlite::Connection;
use serde_json::{json, Value};

use crate::{
    db::{read_setting, write_setting},
    Error, Result,
};

const EXTRA_KEYS: &[(&str, &str, bool)] = &[
    ("gamesTabEnabled", "extra.gamesTabEnabled", true),
    ("voteSystemEnabled", "extra.voteSystemEnabled", false),
    ("autoVoteOnFavorite", "extra.autoVoteOnFavorite", true),
    (
        "readTrackingEnabled",
        "extra.galleryUnreadOnlyEnabled",
        true,
    ),
    (
        "exploreStackDuplicates",
        "extra.exploreStackDuplicates",
        false,
    ),
    ("developerMode", "extra.developerMode", false),
    ("deleteAddedPhotos", "extra.deleteAddedPhotos", false),
];

pub fn read(connection: &Connection, section: &str) -> Result<Value> {
    let value = match section {
        "extra" => {
            let mut settings = json!({"maxGridColumns": read_setting(connection, "extra.maxGridColumns", &json!(0))?});
            for (name, key, default) in EXTRA_KEYS {
                settings[name] = read_setting(connection, key, &json!(default))?;
            }
            settings
        }
        "shortcuts" => json!({"bindings": read_setting(connection, "shortcuts.bindings", &json!({}))?}),
        "blacklist" => read_setting(connection, "blacklist.settings", &json!({"tags": [], "applyToExplore": true, "applyToGallery": false}))?,
        _ => return Err(Error::Unavailable("These settings are not available in this development build. Use Extra, Shortcuts or Blacklist settings.")),
    };
    validate(section, &value)
        .map_err(|error| Error::Storage(format!("invalid saved {section} settings: {error}")))?;
    if section == "blacklist"
        && ["tags", "applyToExplore", "applyToGallery"]
            .iter()
            .any(|key| value.get(key).is_none())
    {
        return Err(Error::Storage(
            "Saved blacklist settings are incomplete.".into(),
        ));
    }
    Ok(value)
}

pub fn update(connection: &mut Connection, section: &str, patch: Value) -> Result<Value> {
    validate(section, &patch)?;
    let transaction = connection.transaction()?;
    let mut next = read(&transaction, section)?;
    for (name, value) in patch.as_object().expect("validated object") {
        next[name] = value.clone();
    }
    match section {
        "extra" => {
            for (name, key, _) in EXTRA_KEYS {
                write_setting(&transaction, key, &next[name])?;
            }
            write_setting(
                &transaction,
                "extra.maxGridColumns",
                &next["maxGridColumns"],
            )?;
        }
        "shortcuts" => write_setting(&transaction, "shortcuts.bindings", &next["bindings"])?,
        "blacklist" => {
            let tags = next["tags"].as_array().expect("validated tags");
            let mut normalized = Vec::new();
            for tag in tags {
                let tag: String = tag
                    .as_str()
                    .expect("validated tag")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join("_")
                    .chars()
                    .filter(|character| {
                        character.is_ascii_alphanumeric() || "_:()-".contains(*character)
                    })
                    .collect::<String>()
                    .to_ascii_lowercase();
                if !tag.is_empty() && !normalized.contains(&tag) {
                    normalized.push(tag);
                }
            }
            next["tags"] = json!(normalized);
            write_setting(&transaction, "blacklist.settings", &next)?;
        }
        _ => {
            return Err(Error::Unavailable(
                "These settings are not available in this development build.",
            ))
        }
    }
    transaction.commit()?;
    Ok(next)
}

fn validate(section: &str, value: &Value) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| Error::Invalid("Settings must be an object.".into()))?;
    for (key, value) in object {
        let valid = match (section, key.as_str()) {
            ("extra", "maxGridColumns") => value.as_u64().is_some_and(|value| value <= 12),
            ("extra", key) if EXTRA_KEYS.iter().any(|(name, _, _)| key == *name) => {
                value.is_boolean()
            }
            ("blacklist", "applyToExplore" | "applyToGallery") => value.is_boolean(),
            ("blacklist", "tags") => value.as_array().is_some_and(|tags| {
                tags.len() <= 500
                    && tags.iter().all(|tag| {
                        tag.as_str()
                            .is_some_and(|tag| !tag.is_empty() && tag.chars().count() <= 100)
                    })
            }),
            ("shortcuts", "bindings") => value.as_object().is_some_and(|bindings| {
                bindings.len() <= 64
                    && bindings.iter().all(|(key, value)| {
                        (1..=32).contains(&key.chars().count())
                            && value
                                .as_str()
                                .is_some_and(|value| (1..=32).contains(&value.chars().count()))
                    })
            }),
            _ => false,
        };
        if !valid {
            return Err(Error::Invalid(format!("Invalid setting: {key}.")));
        }
    }
    if section == "shortcuts" && !object.contains_key("bindings") {
        return Err(Error::Invalid("Shortcut bindings are required.".into()));
    }
    Ok(())
}
