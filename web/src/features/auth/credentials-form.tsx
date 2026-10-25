import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { ApiError } from "../../shared/api/http";
import { Button } from "../../shared/ui/button";
import { Input } from "../../shared/ui/field";
import { useAuth } from "./auth-context";
import { DemoButton } from "../demo/demo-button";

const loginSchema = z.object({ email: z.email("Enter a valid email address"), password: z.string().min(1, "Enter your password") });
const registerSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(10, "Use at least 10 characters").max(128, "At most 128 characters"),
});
type Values = z.infer<typeof loginSchema>;

/** One form for both sign-in and sign-up: they differ only in validation rules, copy and the action. */
export function CredentialsForm({ mode }: { mode: "login" | "register" }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const isRegister = mode === "register";
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(isRegister ? registerSchema : loginSchema), mode: "onTouched" });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await (isRegister ? auth.register(values) : auth.login(values));
      navigate("/", { replace: true });
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "Could not reach the server. Check your connection and try again.");
      // field-level when the server pins it to one, otherwise a form-level message
      if (err.status === 409) setError("email", { message: "An account with this email already exists" });
      else if (err.status === 401) setError("root", { message: "Incorrect email or password" });
      else if (err.status === 429) setError("root", { message: "Too many attempts. Wait a minute and try again." });
      else setError("root", { message: err.message });
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        autoFocus
        placeholder="you@company.com"
        error={errors.email?.message}
        {...register("email")}
      />
      <Input
        label="Password"
        type="password"
        autoComplete={isRegister ? "new-password" : "current-password"}
        hint={isRegister ? "At least 10 characters" : undefined}
        error={errors.password?.message}
        {...register("password")}
      />
      {errors.root?.message && (
        <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-medium text-bad">
          {errors.root.message}
        </p>
      )}
      <Button type="submit" loading={isSubmitting} className="mt-1 w-full">
        {isRegister ? "Create account" : "Sign in"}
      </Button>
      <DemoButton />
      <p className="text-center text-sm text-muted">
        {isRegister ? (
          <>
            Already have an account?{" "}
            <Link to="/login" className="font-medium text-accent hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link to="/register" className="font-medium text-accent hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
