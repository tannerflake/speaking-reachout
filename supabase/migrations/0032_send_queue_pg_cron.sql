-- ===========================================================================
-- Run the send-queue tick every minute.
--
-- Vercel Hobby only allows daily crons, but paced sending (one email every
-- 2-6 minutes in business hours) needs a tick every minute. Supabase pg_cron
-- + pg_net call /api/cron/send-queue with the existing CRON_SECRET. Each call
-- sends at most one email and only when the pacing rules allow, so ticking
-- around the clock is harmless (outside hours it does nothing).
--
-- AFTER applying this migration, store the URL and secret in Supabase Vault
-- (SQL editor; replace the placeholders, keep the quotes):
--
--   select vault.create_secret('https://www.jeffflake.com/api/cron/send-queue', 'send_queue_url');
--   select vault.create_secret('<same value as CRON_SECRET in Vercel>', 'cron_secret');
--
-- Use the www host: the bare domain answers with a redirect, which pg_net
-- does not follow.
--
-- Until both exist the job runs but does nothing. To check it is working:
--   select * from cron.job_run_details order by start_time desc limit 5;
--   select status_code, created from net._http_response order by created desc limit 5;
-- To stop it: select cron.unschedule('send-queue-tick');
-- ===========================================================================

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.trigger_send_queue_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target text;
  secret text;
begin
  select decrypted_secret into target
    from vault.decrypted_secrets where name = 'send_queue_url' limit 1;
  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if target is null or secret is null then
    return;
  end if;
  perform net.http_get(
    url := target,
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.trigger_send_queue_tick() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'send-queue-tick';
select cron.schedule('send-queue-tick', '* * * * *', 'select public.trigger_send_queue_tick()');
