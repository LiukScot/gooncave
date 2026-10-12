use crate::{tags, Error, Result};

// SQLite permits 64 joined tables; reserve room for the file and vote tables.
const MAX_SEARCH_TERMS: usize = 60;
use rusqlite::{types::Value, Connection};
use std::collections::HashSet;

#[derive(Default, Debug, PartialEq)]
struct Query {
    all: Vec<String>,
    any: Vec<String>,
    none: Vec<String>,
    score: Vec<(String, i64, bool)>,
    parent: bool,
    pool: bool,
}

fn parse(input: &str) -> Result<Query> {
    let mut query = Query::default();
    for raw in input
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
    {
        let negated = raw.starts_with('-');
        let alternative = raw.starts_with('~');
        let token = if negated || alternative {
            &raw[1..]
        } else {
            raw
        };
        let lower = token.to_ascii_lowercase();
        if !negated && !alternative && lower == "parent:any" {
            query.parent = true;
            continue;
        }
        if !negated && !alternative && lower == "pool:any" {
            query.pool = true;
            continue;
        }
        if let Some(value) = lower.strip_prefix("score:") {
            let op = [">=", "<=", ">", "<", "="]
                .into_iter()
                .find(|op| value.starts_with(op))
                .unwrap_or("=");
            let number = value.strip_prefix(op).unwrap_or(value);
            let digits = number.strip_prefix('-').unwrap_or(number);
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                let value = number.parse().map_err(|_| {
                    Error::Invalid("The score is outside the supported integer range.".into())
                })?;
                query.score.push((op.into(), value, negated));
            }
            continue;
        }
        let tag = tags::normalize(token);
        let bucket = if negated {
            &mut query.none
        } else if alternative {
            &mut query.any
        } else {
            &mut query.all
        };
        if !tag.is_empty() && !bucket.contains(&tag) {
            bucket.push(tag);
        }
    }
    Ok(query)
}

pub(crate) struct Filter {
    pub joins: String,
    pub conditions: Vec<String>,
    pub join_values: Vec<Value>,
    pub values: Vec<Value>,
}

fn matching(terms: &[String]) -> (String, Vec<Value>) {
    let placeholders = vec!["?"; terms.len()].join(",");
    (format!("(ft.canonical_tag IN ({placeholders}) OR ft.canonical_tag IN
        (SELECT tag FROM tag_implications WHERE implied IN ({placeholders})))
        AND NOT EXISTS (SELECT 1 FROM file_tag_suppressions s WHERE s.file_id=ft.file_id AND s.tag=ft.tag)"),
        terms.iter().chain(terms).cloned().map(Value::from).collect())
}

pub(crate) fn filter(connection: &Connection, input: &str) -> Result<Filter> {
    if input.len() > 16 * 1024 {
        return Err(Error::Invalid(
            "The tag search is too long. Use fewer terms.".into(),
        ));
    }
    let mut query = parse(input)?;
    for bucket in [&mut query.all, &mut query.any, &mut query.none] {
        let mut seen = HashSet::new();
        *bucket = bucket
            .iter()
            .map(|t| tags::canonical(connection, t))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|t| seen.insert(t.clone()))
            .collect();
    }
    if query.all.len() + query.any.len() + query.none.len() + query.score.len() > MAX_SEARCH_TERMS {
        return Err(Error::Invalid(format!(
            "Search with at most {MAX_SEARCH_TERMS} terms."
        )));
    }
    let mut filter = Filter {
        joins: String::new(),
        conditions: Vec::new(),
        join_values: Vec::new(),
        values: Vec::new(),
    };
    let mut groups: Vec<Vec<String>> = query.all.into_iter().map(|t| vec![t]).collect();
    if !query.any.is_empty() {
        groups.push(query.any);
    }
    for (i, terms) in groups.iter().enumerate() {
        let (sql, values) = matching(terms);
        filter.joins.push_str(&format!(" JOIN (SELECT DISTINCT ft.file_id FROM file_tags ft WHERE {sql}) tag_{i} ON tag_{i}.file_id=f.id"));
        filter.join_values.extend(values);
    }
    for term in query.none {
        let (sql, values) = matching(&[term]);
        filter.conditions.push(format!(
            "NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id=f.id AND {sql})"
        ));
        filter.values.extend(values);
    }
    for (op, value, negated) in query.score {
        let sql = format!("COALESCE((SELECT score FROM file_votes WHERE file_id=f.id),0) {op} ?");
        filter
            .conditions
            .push(if negated { format!("NOT ({sql})") } else { sql });
        filter.values.push(value.into());
    }
    if query.parent {
        filter.conditions.push("EXISTS (SELECT 1 FROM file_post_relations WHERE file_id=f.id AND parent_id IS NOT NULL)".into());
    }
    if query.pool {
        filter.conditions.push(
            "EXISTS (SELECT 1 FROM file_post_relations WHERE file_id=f.id AND pool_ids <> '')"
                .into(),
        );
    }
    Ok(filter)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reference_parser_contract() {
        let q = parse("SOLO, solo ~cat ~dog -Blue_Eyes - ~ SCORE:>=5 -score:<-2 ~score:3 parent:any pool:any score:abc").unwrap();
        assert_eq!(q.all, ["solo"]);
        assert_eq!(q.any, ["cat", "dog"]);
        assert_eq!(q.none, ["blue_eyes"]);
        assert_eq!(
            q.score,
            [
                (">=".into(), 5, false),
                ("<".into(), -2, true),
                ("=".into(), 3, false)
            ]
        );
        assert!(q.parent && q.pool);
        assert_eq!(parse("score: score:> - ~").unwrap(), Query::default());
    }
}
