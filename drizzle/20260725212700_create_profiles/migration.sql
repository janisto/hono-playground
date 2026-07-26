CREATE TABLE `profiles` (
	`id` text PRIMARY KEY,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`email` text NOT NULL,
	`phone_number` text NOT NULL,
	`marketing_opt_in` integer DEFAULT false NOT NULL,
	`terms_accepted` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "profiles_id_length" CHECK(length("id") BETWEEN 1 AND 128),
	CONSTRAINT "profiles_first_name_length" CHECK(length("first_name") BETWEEN 1 AND 100),
	CONSTRAINT "profiles_last_name_length" CHECK(length("last_name") BETWEEN 1 AND 100),
	CONSTRAINT "profiles_email_length" CHECK(length("email") BETWEEN 3 AND 254),
	CONSTRAINT "profiles_phone_number_format" CHECK(
        length("phone_number") BETWEEN 8 AND 16
        AND substr("phone_number", 1, 1) = '+'
        AND substr("phone_number", 2, 1) BETWEEN '1' AND '9'
        AND substr("phone_number", 2) NOT GLOB '*[^0-9]*'
      ),
	CONSTRAINT "profiles_marketing_opt_in_boolean" CHECK("marketing_opt_in" IN (0, 1)),
	CONSTRAINT "profiles_terms_accepted" CHECK("terms_accepted" = 1),
	CONSTRAINT "profiles_created_at_nonnegative" CHECK("created_at" >= 0),
	CONSTRAINT "profiles_updated_at_order" CHECK("updated_at" >= "created_at")
) STRICT;
