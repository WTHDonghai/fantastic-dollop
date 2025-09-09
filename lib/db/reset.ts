import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

config({
  path: '.env',
});

const connection = postgres(process.env.POSTGRES_URL!, { max: 1 });
const db = drizzle(connection);

async function resetDatabase() {
  console.log('Starting database reset...');
  
  try {
    // Disable foreign key constraints
    await db.execute(sql`SET session_replication_role = 'replica';`);
    
    // Truncate all tables in the correct order to respect foreign keys
    const tables = [
      'Suggestion',
      'Vote_v2',
      'Vote',
      'Message_v2',
      'Message',
      'Stream',
      'Document',
      'Chat',
      'User'
    ];
    
    for (const table of tables) {
      try {
        await db.execute(sql`TRUNCATE TABLE ${sql.identifier(table)} CASCADE;`);
        console.log(`✓ Truncated ${table}`);
      } catch (error) {
        // Table might not exist (e.g., deprecated tables)
        console.log(`- Skipped ${table} (may not exist)`);
      }
    }
    
    // Re-enable foreign key constraints
    await db.execute(sql`SET session_replication_role = 'origin';`);
    
    console.log('Database reset completed successfully!');
  } catch (error) {
    console.error('Error resetting database:', error);
    process.exit(1);
  }
}

resetDatabase();