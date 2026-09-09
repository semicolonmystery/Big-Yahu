import { useState } from 'react';
import type { FormEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuth } from '@/hooks/useAuth';

function SetupDialog() {
  const { setup } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);

    if (username.trim().length === 0) {
      setValidationError('Username is required.');
      return;
    }
    if (password.length < 8) {
      setValidationError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setValidationError('Passwords do not match.');
      return;
    }
    setValidationError(null);

    setSubmitting(true);
    try {
      await setup(username.trim(), password);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Failed to create admin account.');
    } finally {
      setSubmitting(false);
    }
  };

  const errorMessage = validationError ?? serverError;

  return (
    <Dialog open modal disablePointerDismissal>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Create the admin account</DialogTitle>
          <DialogDescription>
            Big Yahu has no admin yet. Set up the one and only admin account to continue.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-username">Username</Label>
            <Input
              id="setup-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              disabled={submitting}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-password">Password</Label>
            <Input
              id="setup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              disabled={submitting}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-confirm-password">Confirm password</Label>
            <Input
              id="setup-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              disabled={submitting}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating account…' : 'Create admin account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { SetupDialog };
