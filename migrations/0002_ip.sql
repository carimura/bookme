-- The requester's network, for the per-network daily limit on new requests.
ALTER TABLE bookings ADD COLUMN ip TEXT NOT NULL DEFAULT '';
