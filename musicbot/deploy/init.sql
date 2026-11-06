CREATE TABLE IF NOT EXISTS settings (id varchar(70) NOT NULL, bot_id varchar(70) NOT NULL DEFAULT "", data json NOT NULL, PRIMARY KEY(id,bot_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
