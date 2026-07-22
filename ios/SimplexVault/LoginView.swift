import SwiftUI

struct LoginView: View {
    @EnvironmentObject var store: Store

    @State private var username = ""
    @State private var password = ""
    @State private var code = ""            // TOTP, when required
    @State private var ticket: String?      // set when the server asks for 2FA
    @State private var busy = false
    @State private var error: String?
    @State private var showServerSheet = false

    private var needs2fa: Bool { ticket != nil }

    var body: some View {
        ZStack {
            SimplexTheme.bg.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 22) {
                    Spacer(minLength: 60)
                    SimplexMark()
                    Text("your private workspace · sign in")
                        .font(.footnote)
                        .foregroundStyle(SimplexTheme.subtle)

                    VStack(spacing: 14) {
                        if !needs2fa {
                            field("Account") {
                                TextField("username", text: $username)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .textContentType(.username)
                            }
                            field("Password") {
                                SecureField("password", text: $password)
                                    .textContentType(.password)
                                    .onSubmit(submit)
                            }
                        } else {
                            Text("Enter the 6-digit code from your authenticator")
                                .font(.footnote)
                                .foregroundStyle(SimplexTheme.subtle)
                                .multilineTextAlignment(.center)
                            field("Code") {
                                TextField("123456", text: $code)
                                    .keyboardType(.numberPad)
                                    .textContentType(.oneTimeCode)
                                    .onSubmit(submit)
                            }
                        }

                        if let error {
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else if let le = store.lastError {
                            Text(le)
                                .font(.footnote)
                                .foregroundStyle(SimplexTheme.subtle)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Button(action: submit) {
                            HStack {
                                if busy { ProgressView().tint(.black) }
                                Text(needs2fa ? "Verify" : "Sign in").bold()
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                        }
                        .background(SimplexTheme.accent, in: RoundedRectangle(cornerRadius: 10))
                        .foregroundStyle(.black)
                        .disabled(busy || (needs2fa ? code.isEmpty : (username.isEmpty || password.isEmpty)))

                        if needs2fa {
                            Button("Start over") { ticket = nil; code = ""; error = nil }
                                .font(.footnote)
                                .foregroundStyle(SimplexTheme.subtle)
                        }
                    }
                    .padding(18)
                    .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(SimplexTheme.line))
                    .padding(.horizontal, 22)

                    Button {
                        showServerSheet = true
                    } label: {
                        Label("Server", systemImage: "network")
                            .font(.footnote)
                            .foregroundStyle(SimplexTheme.subtle)
                    }
                    Spacer()
                }
                .frame(maxWidth: 460)
                .frame(maxWidth: .infinity)
            }
        }
        .sheet(isPresented: $showServerSheet) { ServerURLSheet() }
    }

    @ViewBuilder
    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label.uppercased())
                .font(.caption2).tracking(1)
                .foregroundStyle(SimplexTheme.subtle)
            content()
                .foregroundStyle(SimplexTheme.text)
                .padding(10)
                .background(SimplexTheme.surface2, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func submit() {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                if let tk = ticket {
                    let acct = try await API.shared.login2fa(ticket: tk, code: code.trimmingCharacters(in: .whitespaces))
                    await store.completeSignIn(acct)
                } else {
                    switch try await API.shared.login(username: username.trimmingCharacters(in: .whitespaces),
                                                       password: password) {
                    case .success(let acct):
                        await store.completeSignIn(acct)
                    case .need2fa(let tk):
                        ticket = tk
                    }
                }
            } catch let e as APIError {
                error = e.message
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Lets the user point the app at a different server (defaults to data.guythatlives.net).
struct ServerURLSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var urlString = API.shared.baseURLSync.absoluteString
    @State private var invalid = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://data.guythatlives.net", text: $urlString)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server URL")
                } footer: {
                    Text("The address of your Simplex server. The default is the public Cloudflare domain.")
                }
                if invalid {
                    Text("That doesn't look like a valid URL.").foregroundStyle(.red)
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func save() {
        var s = urlString.trimmingCharacters(in: .whitespaces)
        if !s.contains("://") { s = "https://" + s }
        guard let url = URL(string: s), url.host != nil else { invalid = true; return }
        Task { await API.shared.setBaseURL(url); dismiss() }
    }
}
