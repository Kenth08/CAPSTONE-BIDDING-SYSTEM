"""Reading stored files for download.

A single place every download goes through, so storage-level concerns (such as
encryption at rest) can be handled without touching the access-control code in
files.py.
"""


def open_for_download(field_file):
    """An open, readable binary handle for `field_file`'s stored bytes."""
    return field_file.open("rb")
