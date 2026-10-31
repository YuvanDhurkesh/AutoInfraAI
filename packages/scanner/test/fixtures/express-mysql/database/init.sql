-- Database initialization script for todo application
-- Create database if it doesn't exist
CREATE DATABASE IF NOT EXISTS todo_db;

USE todo_db;

/* Create the tasks table if needed */
CREATE TABLE IF NOT EXISTS tasks (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(255) NOT NULL);
