mod booru_engines;
mod booru_http;
mod boorus;
pub mod db;
mod explore;
mod files;
pub mod http;
pub mod library;
pub mod media;
mod search;
mod settings;
mod tags;

use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Storage(String),
    Invalid(String),
    Unavailable(&'static str),
    Remote(String),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Sqlite(error) => error.fmt(formatter),
            Self::Storage(message) | Self::Invalid(message) | Self::Remote(message) => {
                formatter.write_str(message)
            }
            Self::Unavailable(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

mod tag_import;
