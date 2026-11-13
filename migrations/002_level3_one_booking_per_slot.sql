-- Level 3: a slot can have at most ONE confirmed booking.
-- The database enforces this, so it holds however many requests arrive at once.
-- Cancelled bookings are outside the index, so cancelling frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id)
  WHERE status = 'confirmed';
