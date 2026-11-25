-- Video signatures took their frames at fractions of a length that counted the sound track.
-- They are a cache: the next duplicate scan takes them again from the picture's own length.
DELETE FROM file_signatures WHERE kind = 'VIDEO';
